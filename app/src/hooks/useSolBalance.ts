import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';

export function useSolBalance(connection: Connection | null, owner: PublicKey | null) {
    const [balance, setBalance] = useState<bigint | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let active = true;
        const load = async () => {
            if (!connection || !owner) {
                setBalance(null);
                return;
            }
            try {
                setLoading(true);
                const lamports = await connection.getBalance(owner, 'confirmed');
                if (active) {
                    setBalance(BigInt(lamports));
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
    }, [connection, owner]);

    return { balance, loading };
}
