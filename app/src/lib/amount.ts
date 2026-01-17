export function parseTokenAmount(value: string, decimals: number): bigint {
    const sanitized = value.trim();
    if (!sanitized) return 0n;
    if (!/^[0-9]*\.?[0-9]*$/.test(sanitized)) {
        throw new Error('Invalid amount');
    }
    const [wholePart, fracPart = ''] = sanitized.split('.');
    const whole = wholePart ? BigInt(wholePart) : 0n;
    const frac = fracPart.slice(0, decimals).padEnd(decimals, '0');
    const fracValue = frac ? BigInt(frac) : 0n;
    const base = 10n ** BigInt(decimals);
    return whole * base + fracValue;
}

export function formatTokenAmount(value: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const frac = value % base;
    if (decimals === 0) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
