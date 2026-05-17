export const USER_FACING_CHANGELOG_TAGS = ["Desktop", "Web"];

const TAG_PATTERN = USER_FACING_CHANGELOG_TAGS.join("|");
const TAGGED_ITEM_RE = new RegExp(`^- \\[((?:${TAG_PATTERN})(?:, (?:${TAG_PATTERN}))*)\\] (.+)$`);

export function parseLatestChangelog(md) {
  return parseChangelogVersion(md);
}

export function parseChangelogVersion(md, targetVersion = "") {
  const versionRe = /^## \[(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]\s*-\s*(\d{4}-\d{2}-\d{2})/gm;
  let first;
  while ((first = versionRe.exec(md)) !== null) {
    if (!targetVersion || first[1] === targetVersion) break;
  }
  if (!first) return null;

  const version = first[1];
  const date = first[2];
  const start = first.index + first[0].length;
  const nextVersion = versionRe.exec(md);
  const end = nextVersion ? nextVersion.index : md.length;
  const sectionText = md.slice(start, end);
  const dividerIdx = sectionText.indexOf("\n---\n");
  const body = dividerIdx > 0 ? sectionText.slice(0, dividerIdx) : sectionText;
  const sections = [];
  const sectionRe = /^### (.+)$/gm;
  const sectionPositions = [];
  let match;

  while ((match = sectionRe.exec(body)) !== null) {
    sectionPositions.push({
      heading: match[1].trim(),
      headingStart: match.index,
      contentStart: sectionRe.lastIndex
    });
  }

  for (let i = 0; i < sectionPositions.length; i++) {
    const section = sectionPositions[i];
    const contentEnd = i + 1 < sectionPositions.length ? sectionPositions[i + 1].headingStart : body.length;
    const items = body.slice(section.contentStart, contentEnd)
      .split("\n")
      .map((line) => line.match(TAGGED_ITEM_RE))
      .filter(Boolean)
      .map((itemMatch) => {
        const tag = itemMatch[1];
        return {
          tag,
          tags: tag.split(", "),
          text: itemMatch[2].trim()
        };
      })
      .filter((item) => item.text);

    if (items.length) sections.push({ heading: section.heading, items });
  }

  return { version, date, sections };
}
