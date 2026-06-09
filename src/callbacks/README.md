# Callbacks

Callbacks are the gateway's low-overhead observability extension point.
Request handlers build one `StandardLoggingPayload` and dispatch it through
`CallbackManager`; individual callbacks decide what to do with that payload.

## Flow

1. `/v1/messages` and `/v1/responses` parse the inbound request.
2. The handler creates `StandardLoggingPayload`.
3. The upstream response path finalizes the payload with status, timing, usage,
   cost, response body, or error information.
4. `CallbackManager` calls `on_success` or `on_error` on every registered
   callback.
5. Callback implementations do their own work outside the request-critical path.

`LiteLLMDBCallback` is the built-in callback. It writes LiteLLM-compatible rows
to `"LiteLLM_SpendLogs"` through an async queue that flushes in batches.

## StandardLoggingPayload

Every callback receives the same typed payload from
`standard_logging.rs`. The important fields are:

- `id`: request id from `x-request-id` / `x-client-request-id`, or generated.
- `call_type`: currently `messages` or `responses`.
- `stream`: whether the upstream request was streaming.
- `status`: `success` or `error`.
- `model`, `model_id`, `model_group`, `custom_llm_provider`, `api_base`.
- `start_time`, `end_time`, `response_time`.
- `usage`: total, prompt, and completion tokens.
- `response_cost`: computed from the model cost map when pricing is available.
- `request`: sanitized inbound request body.
- `response`: sanitized upstream response body, including reconstructed SSE text
  for streaming responses.
- `metadata`: callback-safe metadata, including `user_api_key_hash` and
  `error_information` for failures.
- `error_information`: typed error, message, and forced Rust backtrace.

Callbacks should treat the payload as read-only input. If a callback needs to
persist or forward data, it should map fields internally instead of changing the
request handlers.

## Adding A Callback

Create a new file under `src/callbacks/` and implement `BaseCallback`.

```rust
use tokio::sync::mpsc;

use crate::callbacks::{
    base::BaseCallback,
    standard_logging::StandardLoggingPayload,
};

#[derive(Clone)]
pub struct MyCallback {
    sender: mpsc::Sender<StandardLoggingPayload>,
}

impl MyCallback {
    pub fn new() -> Self {
        let (sender, mut receiver) = mpsc::channel(10_000);
        tokio::spawn(async move {
            while let Some(payload) = receiver.recv().await {
                // Write to your sink here: database, file, OTEL, webhook, etc.
                tracing::info!(
                    request_id = %payload.id,
                    call_type = %payload.call_type,
                    status = %payload.status.as_str(),
                    cost = payload.response_cost,
                    "observability callback received payload"
                );
            }
        });
        Self { sender }
    }
}

impl BaseCallback for MyCallback {
    fn on_success(&self, payload: StandardLoggingPayload) {
        let _ = self.sender.try_send(payload);
    }

    fn on_error(&self, payload: StandardLoggingPayload) {
        let _ = self.sender.try_send(payload);
    }
}
```

Then export the module from `src/callbacks/mod.rs` and register it in
`src/proxy/state.rs`:

```rust
let callbacks = CallbackManager::new(vec![
    Arc::new(LiteLLMDBCallback::new(pool.clone(), &config.general_settings)),
    Arc::new(MyCallback::new()),
]);
```

Keep `on_success` and `on_error` fast. Prefer `try_send` into an internal queue,
then do network or database work in a background task.

## Config Parameters

The built-in DB callback reads these values from `general_settings`:

```yaml
general_settings:
  database_url: postgres://...
  store_prompts_in_spend_logs: true
  disable_spend_logs: false
  spend_logs_batch_interval_seconds: 10
  spend_logs_batch_size: 100
  spend_logs_queue_capacity: 10000
```

- `store_prompts_in_spend_logs`: when `true`, persist request and response
  bodies in `"LiteLLM_SpendLogs"`. When `false`, store `{}` for those fields.
- `disable_spend_logs`: when `true`, do not register `LiteLLMDBCallback`.
- `spend_logs_batch_interval_seconds`: max time before queued rows are flushed.
- `spend_logs_batch_size`: flush immediately when this many rows are queued.
- `spend_logs_queue_capacity`: bounded channel size. If full, new callback
  payloads are dropped with a warning rather than slowing request handling.

Use the same pattern for new callbacks: read config at startup, keep request
hooks non-blocking, and put sink-specific mapping in the callback implementation.

## Testing

For callback behavior, prefer small tests that build a
`StandardLoggingPayload` and assert the fields a callback depends on. For DB
callbacks, use a local Postgres smoke test and query `"LiteLLM_SpendLogs"` after
the batch interval.
