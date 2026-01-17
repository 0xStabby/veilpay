import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export function useMintInfo(connection: Connection | null, mintAddress: string) {
    const [decimals, setDecimals] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let active = true;
        const load = async () => {
            if (!connection || !mintAddress) {
                setDecimals(null);
                return;
            }
            try {
                setLoading(true);
                const mint = new PublicKey(mintAddress);
                const info = await getMint(connection, mint);
                if (active) {
                    setDecimals(info.decimals);
                }
            } catch {
                if (active) {
                    setDecimals(null);
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };
        load();
        return () => {
            active = false;
        };
    }, [connection, mintAddress]);

    return { decimals, loading };
}
