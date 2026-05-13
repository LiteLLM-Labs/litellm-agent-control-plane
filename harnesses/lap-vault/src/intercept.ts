// The whole interception logic in one function.

export interface SwapResult {
  out: string;
  used: string[];
}

export function swap(text: string, kv: Map<string, string>): SwapResult {
  let out = text;
  const used: string[] = [];
  for (const [stub, real] of kv) {
    if (out.includes(stub)) {
      out = out.split(stub).join(real);
      used.push(stub);
    }
  }
  return { out, used };
}

export function isTextLike(contentType: string): boolean {
  return /^(application\/(json|x-www-form-urlencoded|xml|x-ndjson|graphql)|text\/)/i.test(
    contentType ?? "",
  );
}
