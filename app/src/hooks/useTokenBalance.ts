import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';

export function useTokenBalance(connection: Connection | null, mintAddress: string, owner: PublicKey | null) {
    const [balance, setBalance] = useState<bigint | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let active = true;
        const load = async () => {
            if (!connection || !mintAddress || !owner) {
                setBalance(null);
                return;
            }
            try {
                setLoading(true);
                const mint = new PublicKey(mintAddress);
                const ata = await getAssociatedTokenAddress(mint, owner);
                const account = await getAccount(connection, ata);
                if (active) {
                    setBalance(account.amount);
                }
            } catch {
                if (active) {
                    setBalance(0n);
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };
        load();
        const timer = setInterval(load, 5000);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [connection, mintAddress, owner]);

    return { balance, loading };
}
