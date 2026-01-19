import { useState } from 'react';
import type { FC } from 'react';
import styles from './TransactionLogCard.module.css';
import type { TransactionRecord } from '../../lib/transactions';
import { PubkeyBadge } from '../PubkeyBadge';

type TransactionLogCardProps = {
    records: TransactionRecord[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onClear: () => void;
    addressLabels?: Record<string, string>;
};

export const TransactionLogCard: FC<TransactionLogCardProps> = ({
    records,
    selectedId,
    onSelect,
    onClear,
    addressLabels = {},
}) => {
    const selected = records.find((record) => record.id === selectedId) ?? null;
    const [activeTab, setActiveTab] = useState<'summary' | 'accounts' | 'tokens' | 'logs' | 'instructions'>('summary');
    const tx = selected?.details?.tx as
        | {
              slot?: number;
              blockTime?: number | null;
              fee?: number | null;
              err?: unknown;
              accounts?: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
              instructions?: Array<{ programId?: string; accounts?: string[]; data?: string; program?: string; parsed?: unknown }>;
              innerInstructions?: Array<{ index: number; instructions: Array<{ programId?: string; program?: string; parsed?: unknown }> }>;
              logMessages?: string[] | null;
              preBalances?: number[] | null;
              postBalances?: number[] | null;
              preTokenBalances?: Array<{
                  accountIndex: number;
                  mint: string;
                  owner?: string;
                  programId?: string;
                  uiTokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number };
              }>;
              postTokenBalances?: Array<{
                  accountIndex: number;
                  mint: string;
                  owner?: string;
                  programId?: string;
                  uiTokenAmount?: { uiAmountString?: string; amount?: string; decimals?: number };
              }>;
          }
        | undefined;

    const signer = tx?.accounts?.find((account) => account.signer)?.pubkey ?? null;
    const labelFor = (pubkey: string | null | undefined) =>
        pubkey ? addressLabels[pubkey] ?? undefined : undefined;

    const balanceRows =
        tx?.accounts && tx.preBalances && tx.postBalances
            ? tx.accounts.map((account, index) => ({
                  account,
                  pre: tx.preBalances?.[index] ?? 0,
                  post: tx.postBalances?.[index] ?? 0,
                  delta: (tx.postBalances?.[index] ?? 0) - (tx.preBalances?.[index] ?? 0),
              }))
            : [];

    const tokenBalanceRows =
        tx?.preTokenBalances && tx?.postTokenBalances
            ? tx.preTokenBalances.map((pre) => {
                  const post = tx.postTokenBalances?.find((entry) => entry.accountIndex === pre.accountIndex);
                  const preUi = pre.uiTokenAmount?.uiAmountString ?? pre.uiTokenAmount?.amount ?? '0';
                  const postUi = post?.uiTokenAmount?.uiAmountString ?? post?.uiTokenAmount?.amount ?? '0';
                  return {
                      accountIndex: pre.accountIndex,
                      mint: pre.mint,
                      owner: pre.owner ?? post?.owner ?? 'unknown',
                      pre: preUi,
                      post: postUi,
                  };
              })
            : [];

    return (
        <section className={styles.card}>
            <header className={styles.header}>
                <div>
                    <h2>Transaction Log</h2>
                    <p>Inspect every on-chain transaction from the flows.</p>
                </div>
                <button className={styles.clearButton} onClick={onClear} disabled={records.length === 0}>
                    Clear
                </button>
            </header>
            <div className={styles.body}>
                <div className={styles.list}>
                    {records.length === 0 && <p className={styles.empty}>No transactions yet.</p>}
                    {records.map((record) => (
                        <button
                            key={record.id}
                            className={record.id === selectedId ? styles.listItemActive : styles.listItem}
                            onClick={() => onSelect(record.id)}
                        >
                            <span className={styles.itemTitle}>{record.flow}</span>
                            <span className={styles.itemMeta}>
                                {record.relayer ? 'relayer' : 'direct'} · {new Date(record.createdAt).toLocaleTimeString()}
                            </span>
                            {record.signature && <span className={styles.itemSig}>{record.signature.slice(0, 12)}...</span>}
                        </button>
                    ))}
                </div>
                <div className={styles.detail}>
                    {!selected && <p className={styles.empty}>Select a transaction to view details.</p>}
                    {selected && (
                        <>
                            <div className={styles.detailHeader}>
                                <h3>{selected.flow}</h3>
                                <span className={styles.detailStatus}>{selected.status}</span>
                            </div>
                            <div className={styles.detailRow}>
                                <span>Signature</span>
                                {selected.signature ? <PubkeyBadge value={selected.signature} /> : <code>n/a</code>}
                            </div>
                            <div className={styles.detailRow}>
                                <span>Submitted via</span>
                                <code>{selected.relayer ? 'relayer' : 'wallet'}</code>
                            </div>
                            <div className={styles.detailRow}>
                                <span>Signer</span>
                                {signer ? <PubkeyBadge value={signer} hoverLabel={labelFor(signer)} /> : <code>n/a</code>}
                            </div>
                            <div className={styles.detailRow}>
                                <span>Timestamp</span>
                                <code>{new Date(selected.createdAt).toLocaleString()}</code>
                            </div>
                            <div className={styles.tabBar}>
                                {[
                                    { id: 'summary', label: 'Summary' },
                                    { id: 'accounts', label: 'Accounts' },
                                    { id: 'tokens', label: 'Tokens' },
                                    { id: 'logs', label: 'Logs' },
                                    { id: 'instructions', label: 'Instructions' },
                                ].map((tab) => (
                                    <button
                                        key={tab.id}
                                        className={activeTab === tab.id ? styles.tabActive : styles.tab}
                                        onClick={() => setActiveTab(tab.id as typeof activeTab)}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>

                            {activeTab === 'summary' && (
                                <div className={styles.summaryGrid}>
                                    <div>
                                        <span>Mint</span>
                                        {selected.details?.mint ? (
                                            <PubkeyBadge value={String(selected.details.mint)} hoverLabel={labelFor(String(selected.details.mint))} />
                                        ) : (
                                            <strong>n/a</strong>
                                        )}
                                    </div>
                                    <div>
                                        <span>Recipient</span>
                                        {selected.details?.recipient || selected.details?.payee ? (
                                            <PubkeyBadge
                                                value={String(selected.details.recipient ?? selected.details.payee)}
                                                hoverLabel={labelFor(String(selected.details.recipient ?? selected.details.payee))}
                                            />
                                        ) : (
                                            <strong>n/a</strong>
                                        )}
                                    </div>
                                    <div>
                                        <span>Amount</span>
                                        <strong>{String(selected.details?.amount ?? 'n/a')}</strong>
                                    </div>
                                    <div>
                                        <span>Fee (lamports)</span>
                                        <strong>{tx?.fee ?? 'n/a'}</strong>
                                    </div>
                                    <div>
                                        <span>Slot</span>
                                        <strong>{tx?.slot ?? 'n/a'}</strong>
                                    </div>
                                    <div>
                                        <span>Error</span>
                                        <strong>{tx?.err ? 'failed' : 'none'}</strong>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'accounts' && (
                                <div className={styles.detailBlock}>
                                    <span>Account balances (lamports)</span>
                                    {balanceRows.length === 0 && <p className={styles.empty}>No balance data.</p>}
                                    {balanceRows.length > 0 && (
                                        <div className={styles.table}>
                                            <div className={styles.tableHeader}>
                                                <span>Account</span>
                                                <span>Pre</span>
                                                <span>Post</span>
                                                <span>Δ</span>
                                            </div>
                                            {balanceRows.map((row) => (
                                                <div key={row.account.pubkey} className={styles.tableRow}>
                                                    <PubkeyBadge
                                                        value={row.account.pubkey}
                                                        hoverLabel={labelFor(row.account.pubkey)}
                                                    />
                                                    <span>{row.pre}</span>
                                                    <span>{row.post}</span>
                                                    <span className={row.delta >= 0 ? styles.deltaPos : styles.deltaNeg}>
                                                        {row.delta}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'tokens' && (
                                <div className={styles.detailBlock}>
                                    <span>Token balance changes</span>
                                    {tokenBalanceRows.length === 0 && <p className={styles.empty}>No token data.</p>}
                                    {tokenBalanceRows.length > 0 && (
                                        <div className={styles.table}>
                                            <div className={styles.tokenTableHeader}>
                                                <span>Account Index</span>
                                                <span>Owner</span>
                                                <span>Mint</span>
                                                <span>Pre</span>
                                                <span>Post</span>
                                            </div>
                                            {tokenBalanceRows.map((row) => (
                                                <div key={`${row.accountIndex}-${row.mint}`} className={styles.tokenTableRow}>
                                                    <span>{row.accountIndex}</span>
                                                    <PubkeyBadge value={row.owner} density="compact" hoverLabel={labelFor(row.owner)} />
                                                    <PubkeyBadge value={row.mint} density="compact" hoverLabel={labelFor(row.mint)} />
                                                    <span>{row.pre}</span>
                                                    <span>{row.post}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'logs' && (
                                <div className={styles.detailBlock}>
                                    <span>Program logs</span>
                                    {!tx?.logMessages?.length && <p className={styles.empty}>No logs.</p>}
                                    {tx?.logMessages && tx.logMessages.length > 0 && (
                                        <pre className={styles.logBlock}>{tx.logMessages.join('\n')}</pre>
                                    )}
                                </div>
                            )}

                            {activeTab === 'instructions' && (
                                <div className={styles.detailBlock}>
                                    <span>Instructions</span>
                                    {!tx?.instructions?.length && <p className={styles.empty}>No instructions.</p>}
                                    {tx?.instructions && tx.instructions.length > 0 && (
                                        <div className={styles.instructionList}>
                                            {tx.instructions.map((ix, index) => (
                                                <div
                                                    key={`${ix.programId ?? ix.program ?? 'ix'}-${index}`}
                                                    className={styles.instructionItem}
                                                >
                                                    <div className={styles.instructionHeader}>
                                                        {ix.programId || ix.program ? (
                                                            <PubkeyBadge
                                                                value={String(ix.programId ?? ix.program)}
                                                                hoverLabel={labelFor(String(ix.programId ?? ix.program))}
                                                            />
                                                        ) : (
                                                            <code>unknown program</code>
                                                        )}
                                                        <span>#{index + 1}</span>
                                                    </div>
                                                    {ix.accounts && ix.accounts.length > 0 && (
                                                        <div className={styles.instructionAccounts}>
                                                            {ix.accounts.map((account) => (
                                                                <PubkeyBadge key={account} value={account} hoverLabel={labelFor(account)} />
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </section>
    );
};
