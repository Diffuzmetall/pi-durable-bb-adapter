/** Presentation only: identity and permissions never derive from these labels. */
export function nativeChildTitle(name: string, role: string, model?: {provider: string; modelId: string}): string {
  const part = (value: string, limit: number) => Array.from(value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
  const parts = [part(name, 180), part(role, 24)];
  if (model?.provider && model.modelId) parts.push(part(`${model.provider}/${model.modelId}`, 40));
  return parts.filter(Boolean).join(' · '); // <=494 UTF-16 units, within Core's 500-unit title limit.
}
