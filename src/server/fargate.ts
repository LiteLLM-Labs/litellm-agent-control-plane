/**
 * ECS Fargate task lifecycle for managed agent sandboxes.
 *
 * Ported from litellm/proxy/managed_agents_endpoints/fargate/tasks.py
 * (boto3 -> AWS SDK v3). Same semantics:
 *   - runTask launches a Fargate task with an awsvpc public-IP ENI, tagged
 *     with session_id + agent_id so the reconciler can find orphans.
 *   - waitRunningGetIp polls describe_tasks until RUNNING, resolves the ENI
 *     to its public IP via EC2.
 *   - waitHttpReady probes the harness HTTP endpoint until any non-5xx
 *     response (matches the Python ref: server-up-but-path-wrong is ready).
 *   - stopTask is idempotent — already-stopped / unknown task errors are
 *     swallowed.
 *   - listTaggedTasks paginates list_tasks across active desired statuses
 *     and batches describe_tasks(include=TAGS) to reattach session/agent
 *     tags.
 */

import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import type {
  KeyValuePair,
  ListTasksCommandOutput,
  Tag,
  Task,
} from "@aws-sdk/client-ecs";
import {
  DescribeNetworkInterfacesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { fromEnv } from "@aws-sdk/credential-providers";
import { fetch } from "undici";

import { env } from "@/server/env";
import {
  TAG_AGENT_ID,
  TAG_SESSION_ID,
  type RunTaskOpts,
  type TaggedTask,
} from "@/server/types";

// ---------------------------------------------------------------------------
// Module-level singletons. Created once per Node process; reused across calls.
// ---------------------------------------------------------------------------

const ecs = new ECSClient({
  region: env.AWS_REGION,
  credentials: fromEnv(),
});

const ec2 = new EC2Client({
  region: env.AWS_REGION,
  credentials: fromEnv(),
});

const CONTAINER_NAME = "harness";
const DEFAULT_RUNNING_TIMEOUT_MS = 600_000;
const DEFAULT_HTTP_READY_TIMEOUT_MS = 600_000;
const POLL_RUNNING_INTERVAL_MS = 3_000;
const POLL_HTTP_INTERVAL_MS = 2_000;
const HTTP_PROBE_TIMEOUT_MS = 3_000;
const DESCRIBE_BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContainerEnv(opts: RunTaskOpts): KeyValuePair[] {
  const { agent } = opts;
  const base: Record<string, string> = {
    REPO_URL: agent.repo_url ?? env.PREINSTALLED_GITHUB_REPO,
    BRANCH: agent.branch,
    LITELLM_API_KEY: env.LITELLM_API_KEY,
    LITELLM_API_BASE: env.LITELLM_API_BASE,
    LITELLM_DEFAULT_MODEL: agent.model,
    AGENT_PROMPT: agent.prompt ?? "",
    PORT: String(agent.container_port),
  };
  // Passthrough takes lower priority than the explicit keys above so a
  // user can't accidentally clobber required runtime config.
  const merged: Record<string, string> = {
    ...env.containerEnvPassthrough,
    ...base,
  };
  return Object.entries(merged).map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

export async function runTask(
  opts: RunTaskOpts,
): Promise<{ task_arn: string }> {
  const { agent, session_id } = opts;

  const tags: Tag[] = [
    { key: TAG_SESSION_ID, value: session_id },
    { key: TAG_AGENT_ID, value: agent.agent_id },
  ];

  const command = new RunTaskCommand({
    cluster: env.AWS_CLUSTER,
    taskDefinition: agent.task_definition_arn,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: env.AWS_SUBNETS,
        securityGroups: [env.AWS_SECURITY_GROUP],
        assignPublicIp: "ENABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: CONTAINER_NAME,
          environment: buildContainerEnv(opts),
        },
      ],
    },
    tags,
  });

  const response = await ecs.send(command);

  if (response.failures && response.failures.length > 0) {
    const detail = response.failures
      .map((f) => `${f.arn ?? "?"}: ${f.reason ?? "?"} ${f.detail ?? ""}`)
      .join("; ");
    throw new Error(`run_task failures: ${detail}`);
  }

  const arn = response.tasks?.[0]?.taskArn;
  if (!arn) {
    throw new Error("run_task returned no task ARN");
  }
  return { task_arn: arn };
}

// ---------------------------------------------------------------------------
// stopTask — idempotent
// ---------------------------------------------------------------------------

export async function stopTask(
  task_arn: string,
  reason: string = "session-ended",
): Promise<void> {
  try {
    await ecs.send(
      new StopTaskCommand({
        cluster: env.AWS_CLUSTER,
        task: task_arn,
        reason,
      }),
    );
  } catch (err) {
    // Idempotency: already-stopped or unknown task should not fail callers.
    const name =
      err instanceof Error ? (err as Error & { name?: string }).name ?? "" : "";
    if (
      name === "ClientException" ||
      name === "InvalidParameterException"
    ) {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// waitRunningGetIp
// ---------------------------------------------------------------------------

function extractEniId(task: Task): string | undefined {
  const attachments = task.attachments ?? [];
  for (const att of attachments) {
    const details = att.details ?? [];
    for (const kv of details) {
      if (kv.name === "networkInterfaceId" && kv.value) {
        return kv.value;
      }
    }
  }
  return undefined;
}

export async function waitRunningGetIp(
  task_arn: string,
  timeout_ms: number = DEFAULT_RUNNING_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeout_ms;

  while (Date.now() < deadline) {
    const desc = await ecs.send(
      new DescribeTasksCommand({
        cluster: env.AWS_CLUSTER,
        tasks: [task_arn],
      }),
    );
    const task = desc.tasks?.[0];
    if (!task) {
      // Task not yet visible. Retry until deadline.
      await sleep(POLL_RUNNING_INTERVAL_MS);
      continue;
    }

    const status = task.lastStatus;
    if (status === "STOPPED") {
      const containerReasons = (task.containers ?? [])
        .map((c) => c.reason ?? "")
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `task stopped: ${task.stoppedReason ?? "?"} containers=[${containerReasons}]`,
      );
    }

    if (status === "RUNNING") {
      const eniId = extractEniId(task);
      if (eniId) {
        const ni = await ec2.send(
          new DescribeNetworkInterfacesCommand({
            NetworkInterfaceIds: [eniId],
          }),
        );
        const ip = ni.NetworkInterfaces?.[0]?.Association?.PublicIp;
        if (ip) {
          return ip;
        }
      }
    }

    await sleep(POLL_RUNNING_INTERVAL_MS);
  }

  throw new Error(
    `task ${task_arn} never reached RUNNING with public IP within ${timeout_ms}ms`,
  );
}

// ---------------------------------------------------------------------------
// waitHttpReady — probes /session per Python reference (opencode harness has
// no /health endpoint). Any non-5xx counts as ready; connection refused and
// 5xx are retried until the deadline.
// ---------------------------------------------------------------------------

export async function waitHttpReady(
  sandbox_url: string,
  timeout_ms: number = DEFAULT_HTTP_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  const probeUrl = `${sandbox_url.replace(/\/+$/, "")}/session`;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, {
        method: "GET",
        signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
      });
      if (res.status < 500) {
        // Any 2xx OR 4xx — server is up.
        return;
      }
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(POLL_HTTP_INTERVAL_MS);
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `sandbox never ready at ${probeUrl} within ${timeout_ms}ms: ${detail}`,
  );
}

// ---------------------------------------------------------------------------
// listTaggedTasks
// ---------------------------------------------------------------------------

async function listAllTaskArns(): Promise<string[]> {
  const arns: string[] = [];
  // Mirror the Python reference: enumerate active desired statuses. ECS
  // ListTasks returns tasks in the given desiredStatus; we want everything
  // except STOPPED for live reconciliation.
  for (const desiredStatus of ["RUNNING", "PENDING"] as const) {
    let nextToken: string | undefined = undefined;
    do {
      const page: ListTasksCommandOutput = await ecs.send(
        new ListTasksCommand({
          cluster: env.AWS_CLUSTER,
          desiredStatus,
          nextToken,
        }),
      );
      if (page.taskArns) arns.push(...page.taskArns);
      nextToken = page.nextToken;
    } while (nextToken);
  }
  return arns;
}

function tagValue(tags: Tag[] | undefined, key: string): string | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t.key === key && typeof t.value === "string") return t.value;
  }
  return null;
}

export async function listTaggedTasks(): Promise<TaggedTask[]> {
  const arns = await listAllTaskArns();
  if (arns.length === 0) return [];

  const out: TaggedTask[] = [];
  for (let i = 0; i < arns.length; i += DESCRIBE_BATCH_SIZE) {
    const batch = arns.slice(i, i + DESCRIBE_BATCH_SIZE);
    const desc = await ecs.send(
      new DescribeTasksCommand({
        cluster: env.AWS_CLUSTER,
        tasks: batch,
        include: ["TAGS"],
      }),
    );
    for (const task of desc.tasks ?? []) {
      if (!task.taskArn) continue;
      out.push({
        task_arn: task.taskArn,
        session_id: tagValue(task.tags, TAG_SESSION_ID),
        agent_id: tagValue(task.tags, TAG_AGENT_ID),
        last_status: task.lastStatus ?? "UNKNOWN",
        started_at: task.startedAt ?? null,
      });
    }
  }
  return out;
}
