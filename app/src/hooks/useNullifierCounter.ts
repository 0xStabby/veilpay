import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'veilpay.nullifierIndex';

export function useNullifierCounter(initialValue = 1) {
    const [value, setValue] = useState<number>(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        const parsed = stored ? Number(stored) : initialValue;
        return Number.isFinite(parsed) && parsed > 0 ? parsed : initialValue;
    });
    const ref = useRef(value);

    useEffect(() => {
        ref.current = value;
        localStorage.setItem(STORAGE_KEY, value.toString());
    }, [value]);

    const next = useCallback(() => {
        const current = ref.current;
        const nextValue = current + 1;
        ref.current = nextValue;
        setValue(nextValue);
        localStorage.setItem(STORAGE_KEY, nextValue.toString());
        return current;
    }, []);

    return { current: value, next };
}
