// (임시) Edge Function egress IP / 프록시 지원 확인용 — 확인 후 삭제
Deno.serve(async () => {
  const r = await fetch("https://api.ipify.org?format=json");
  const ip = ((await r.json()) as { ip: string }).ip;
  return new Response(
    JSON.stringify({
      ip,
      hasCreateHttpClient: typeof (Deno as unknown as Record<string, unknown>).createHttpClient,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
