import { writeClipboardText } from "../server/clipboard.js";

/** OSC 52 clipboard write, understood by most modern terminals including
 * over SSH. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function remoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT);
}

/** Copies on the machine the user is sitting at: the attached client's
 * native clipboard, or the outer terminal via OSC 52 when attached over SSH
 * or when no native tool is available. */
export async function copyToClipboard(
  text: string,
  write: (data: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (remoteSession(env)) {
    write(osc52(text));
    return;
  }
  try {
    await writeClipboardText(text);
  } catch {
    write(osc52(text));
  }
}
