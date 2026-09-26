import { colors, spacing, radius, shadows, typeScale, numericWeights, webFontStack, durations } from '@rayed/design-system';

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function colorVariables(source: Record<string, unknown>, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(source)) {
    const name = `${prefix}-${kebab(key)}`;
    if (typeof value === 'string') out.push(`${name}:${value}`);
    else if (value && typeof value === 'object') colorVariables(value as Record<string, unknown>, name, out);
  }
}

/** CSS custom properties generated from the design-system tokens (the only source of colors in the dashboard). */
export function themeCss(): string {
  const vars: string[] = [];
  colorVariables(colors as unknown as Record<string, unknown>, '--c', vars);
  for (const [key, value] of Object.entries(spacing)) vars.push(`--sp-${key}:${value}px`);
  for (const [key, value] of Object.entries(radius)) vars.push(`--r-${key}:${value}px`);
  for (const [key, value] of Object.entries(shadows)) vars.push(`--sh-${kebab(key)}:${value.web}`);
  for (const [key, value] of Object.entries(durations)) vars.push(`--d-${kebab(key)}:${value}ms`);
  for (const [key, token] of Object.entries(typeScale)) {
    const name = kebab(key);
    vars.push(`--t-${name}-size:${token.fontSize}px`);
    vars.push(`--t-${name}-lh:${token.lineHeight}px`);
    vars.push(`--t-${name}-weight:${numericWeights[token.weight]}`);
  }
  vars.push(`--font:${webFontStack}`);
  return `:root{${vars.join(';')}}`;
}
