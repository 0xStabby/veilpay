import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import styles from './PubkeyBadge.module.css';

type PubkeyBadgeProps = {
    value: string;
    density?: 'compact' | 'normal';
    hoverLabel?: string;
};

function measureText(text: string, font: string) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return text.length * 8;
    context.font = font;
    return context.measureText(text).width;
}

function middleEllipsis(value: string, maxWidth: number, font: string) {
    if (measureText(value, font) <= maxWidth) return value;
    const minKeep = 4;
    let left = minKeep;
    let right = minKeep;
    let best = `${value.slice(0, left)}...${value.slice(-right)}`;
    for (let total = value.length; total > minKeep * 2; total--) {
        const keep = Math.max(minKeep, Math.floor(total / 2));
        left = keep;
        right = keep;
        const candidate = `${value.slice(0, left)}...${value.slice(-right)}`;
        if (measureText(candidate, font) <= maxWidth) {
            best = candidate;
            break;
        }
    }
    // If still too wide, shrink more aggressively.
    while (measureText(best, font) > maxWidth && left > 1 && right > 1) {
        left -= 1;
        right -= 1;
        best = `${value.slice(0, left)}...${value.slice(-right)}`;
    }
    return best;
}

export const PubkeyBadge: FC<PubkeyBadgeProps> = ({ value, density = 'normal', hoverLabel }) => {
    const [copied, setCopied] = useState(false);
    const label = hoverLabel ?? '';
    const displayValue = label || value;
    const [display, setDisplay] = useState(displayValue);
    const badgeRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        const node = badgeRef.current;
        if (!node) return;
        const style = getComputedStyle(node);
        const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const update = () => {
            const padding =
                parseFloat(style.paddingLeft || '0') +
                parseFloat(style.paddingRight || '0') +
                parseFloat(style.borderLeftWidth || '0') +
                parseFloat(style.borderRightWidth || '0');
            const maxWidth = node.clientWidth - padding - 8;
            if (maxWidth <= 0) {
                setDisplay(displayValue);
                return;
            }
            if (label) {
                setDisplay(displayValue);
                return;
            }
            const target = density === 'compact' ? Math.min(maxWidth, 120) : maxWidth;
            setDisplay(middleEllipsis(displayValue, target, font));
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, [displayValue, density]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            // ignore clipboard errors
        }
    };

    return (
        <button ref={badgeRef} type="button" className={styles.badge} onClick={handleCopy} title={value}>
            <span className={styles.text}>{display}</span>
            <span className={styles.hover}>
                {label ? value : copied ? 'Copied' : 'Copy'}
            </span>
        </button>
    );
};
