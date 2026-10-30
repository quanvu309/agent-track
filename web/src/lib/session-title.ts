/** What a raw session title or prompt reads as. `muted` marks text the user didn't type: a bare command name, a system note, or a placeholder. */
export type DisplayTitle = { text: string; muted: boolean }

const META_BLOCK = /<(command-message|command-name|t3_context|system-reminder|local-command-[\w-]+)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/g
const TAG = /<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi
const PARTIAL_TAG = /<\/?[a-z][\w-]*[^>]*$/i
const IMAGE = /\[(?:Attached )?image\b[^\]]*\]?/gi
const LEADING_COMMAND = /^[$/]([a-z][\w:.-]*)(?=\s|$)\s*/i
const READABLE = /[\p{L}\p{N}]{2}/u

/** Prompts the harness injects rather than the user types, named by what they are. */
const INJECTED: [RegExp, string][] = [
  [/^\s*#\s*AGENTS\.md instructions/, "AGENTS.md instructions"],
]

function commandName(raw: string): string | null {
  return (
    raw.match(/<command-message>([^<]+)<\/command-message>/)?.[1].trim() ??
    raw.match(/<command-name>\/?([^<\s]+)/)?.[1] ??
    raw.trimStart().match(LEADING_COMMAND)?.[1] ??
    null
  )
}

/** Turns a raw session title or prompt into a readable one-line title. Keep the raw text for the title attribute and the drill-down. */
export function displayTitle(raw: string | null | undefined, empty = "Untitled session"): DisplayTitle {
  const src = raw ?? ""
  if (src.includes("<task-notification")) {
    const summary = src.match(/<summary>([^<]*)/)?.[1].replace(/\s+/g, " ").trim()
    return { text: summary ? `Task update: ${summary}` : "Task update", muted: true }
  }
  const injected = INJECTED.find(([re]) => re.test(src))
  if (injected) return { text: injected[1], muted: true }
  let text = src.replace(META_BLOCK, " ").replace(TAG, " ").replace(PARTIAL_TAG, "").replace(IMAGE, " ").trim()
  const commands: string[] = []
  for (let m = text.match(LEADING_COMMAND); m; m = text.match(LEADING_COMMAND)) {
    commands.push(m[1])
    text = text.slice(m[0].length)
  }
  text = text.replace(/^#+\s+/, "").replace(/\s+/g, " ").trim()
  // A short remainder like "for this folder" only makes sense next to its command.
  if (commands.length && text && text.split(" ").length < 4) text = `${commands.join(" ")} ${text}`
  const note = text.match(/^\[([^\]]+)\]$/)
  if (note) return { text: note[1], muted: true }
  if (READABLE.test(text)) return { text, muted: false }
  return { text: commandName(src) ?? empty, muted: true }
}
