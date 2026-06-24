// Push the digest to your phone via ntfy.sh (keyless, free).
// Set NTFY_TOPIC to a hard-to-guess string; subscribe in the ntfy app.

export async function pushDigest({ topic, title, body, clickUrl }) {
  if (!topic) {
    console.log("[notify] NTFY_TOPIC not set — skipping push.");
    return false;
  }
  try {
    const headers = {
      Title: encodeURIComponent(title || "Info Radar").replace(/%20/g, " "),
      Tags: "satellite",
      Priority: "default",
    };
    if (clickUrl) headers.Click = clickUrl;
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body: body || "(empty digest)",
    });
    return res.ok;
  } catch (e) {
    console.log("[notify] push failed:", e.message);
    return false;
  }
}
