import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';

function storageKey(mintAddress: string, owner: PublicKey | null) {
    const ownerKey = owner ? owner.toBase58() : 'unknown';
    return `veilpay.balance.${ownerKey}.${mintAddress}`;
}

export function useShieldedBalance(mintAddress: string, owner: PublicKey | null) {
    const key = useMemo(() => storageKey(mintAddress, owner), [mintAddress, owner]);
    const [balance, setBalance] = useState<bigint>(0n);

    useEffect(() => {
        const raw = localStorage.getItem(key);
        if (!raw) {
            setBalance(0n);
            return;
        }
        try {
            setBalance(BigInt(raw));
        } catch {
            setBalance(0n);
        }
    }, [key]);

    const write = useCallback((next: bigint) => {
        setBalance(next);
        localStorage.setItem(key, next.toString());
    }, [key]);

    const credit = useCallback((amount: bigint) => {
        write(balance + amount);
    }, [balance, write]);

    const debit = useCallback((amount: bigint) => {
        const next = balance - amount;
        write(next >= 0n ? next : 0n);
    }, [balance, write]);

    return { balance, credit, debit, setBalance: write };
}
