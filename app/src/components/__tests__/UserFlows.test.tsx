import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserDepositCard } from '../UserDepositCard';
import { UserWithdrawCard } from '../UserWithdrawCard';
import { formatTokenAmount } from '../../lib/amount';

describe('User flow cards', () => {
    it('fills deposit amount from wallet balance button', async () => {
        const user = userEvent.setup();
        const balance = 123450000n;
        const decimals = 6;
        const expected = formatTokenAmount(balance, decimals);

        render(
            <UserDepositCard
                veilpayProgram={null}
                mintAddress="So11111111111111111111111111111111111111112"
                onStatus={() => undefined}
                onRootChange={() => undefined}
                mintDecimals={decimals}
                walletBalance={balance}
                onCredit={() => undefined}
            />
        );

        const button = screen.getByRole('button', { name: new RegExp(`Wallet: ${expected}`) });
        await user.click(button);

        const input = screen.getByLabelText('Amount (tokens)') as HTMLInputElement;
        expect(input.value).toBe(expected);
    });

    it('fills withdraw amount from shielded balance button', async () => {
        const user = userEvent.setup();
        const balance = 500000n;
        const decimals = 6;
        const expected = formatTokenAmount(balance, decimals);

        render(
            <UserWithdrawCard
                veilpayProgram={null}
                mintAddress="So11111111111111111111111111111111111111112"
                onStatus={() => undefined}
                root={new Uint8Array(32)}
                nextNullifier={() => 0}
                mintDecimals={decimals}
                shieldedBalance={balance}
                onDebit={() => undefined}
            />
        );

        const button = screen.getByRole('button', { name: new RegExp(`VeilPay balance: ${expected}`) });
        await user.click(button);

        const input = screen.getByLabelText('Amount (tokens)') as HTMLInputElement;
        expect(input.value).toBe(expected);
    });
});
