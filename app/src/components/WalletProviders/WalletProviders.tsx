import { useMemo } from 'react';
import type { FC, ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { LOCALNET_RPC } from '../../lib/config';

import '@solana/wallet-adapter-react-ui/styles.css';

type WalletProvidersProps = {
    children: ReactNode;
};

export const WalletProviders: FC<WalletProvidersProps> = ({ children }) => {
    const endpoint = useMemo(() => LOCALNET_RPC, []);
    const wallets = useMemo(() => [], []);

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
};
