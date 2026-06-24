// Minimal dependency-free RSS / Atom parser.
// Good enough for well-formed feeds; tolerant of CDATA and entities.

function decodeEntities(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s = "") {
  // Unwrap CDATA first, THEN strip tags, THEN decode entities — order matters,
  // otherwise "<![CDATA[...]]>" gets eaten by the tag regex.
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Strip real tags, decode entities (turns escaped &lt;b&gt; into <b>),
  // then strip once more to catch those now-literal tags.
  const out = decodeEntities(noCdata.replace(/<[^>]+>/g, " ")).replace(/<[^>]+>/g, " ");
  return out.replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  // first matching <name ...>...</name>
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function attr(block, name, a) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

export function parseFeed(xml) {
  if (!xml || typeof xml !== "string") return [];
  const items = [];

  // RSS <item>
  const rssItems = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    const link =
      decodeEntities(tag(block, "link")) ||
      attr(block, "link", "href") ||
      decodeEntities(tag(block, "guid"));
    items.push({
      title: stripTags(tag(block, "title")),
      link: link.trim(),
      summary: stripTags(tag(block, "description") || tag(block, "content:encoded")),
      published: decodeEntities(tag(block, "pubDate") || tag(block, "dc:date")),
    });
  }

  // Atom <entry>
  const atomEntries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomEntries) {
    let link = attr(block, "link", "href");
    if (!link) link = decodeEntities(tag(block, "id"));
    items.push({
      title: stripTags(tag(block, "title")),
      link: link.trim(),
      summary: stripTags(tag(block, "summary") || tag(block, "content")),
      published: decodeEntities(tag(block, "updated") || tag(block, "published")),
    });
  }

  return items.filter((it) => it.title && it.link);
}
