function legacyCopy(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

/**
 * Copies text that is not available yet (e.g. a link that exists only once an upload finishes).
 * Safari and Firefox only allow clipboard writes that start during a user gesture, so the write is
 * opened right away with a pending ClipboardItem and filled in when the text resolves.
 */
export async function copyWhenReady(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // Fall through to a direct write once the text is known.
    }
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}
