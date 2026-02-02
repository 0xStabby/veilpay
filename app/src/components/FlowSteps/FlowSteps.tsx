import type { FC } from 'react';
import styles from './FlowSteps.module.css';
import type { FlowStep, FlowStepStatus } from '../../lib/flowSteps';

const statusLabel: Record<FlowStepStatus, string> = {
    idle: 'pending',
    running: 'running',
    success: 'done',
    error: 'error',
};

type FlowStepsProps = {
    title?: string;
    steps: FlowStep[];
    status: Record<string, FlowStepStatus>;
    compact?: boolean;
};

export const FlowSteps: FC<FlowStepsProps> = ({ title = 'Flow steps', steps, status, compact = false }) => {
    return (
        <section className={compact ? styles.compact : styles.card}>
            {title ? (
                <header className={styles.header}>
                    <h4>{title}</h4>
                    {!compact && <p>We will walk through each signature and on-chain step.</p>}
                </header>
            ) : null}
            <div className={styles.list}>
                {steps.map((step, index) => {
                    const stepStatus = status[step.id] ?? 'idle';
                    return (
                        <div key={step.id} className={styles.row} data-status={stepStatus}>
                            <span className={styles.index}>{index + 1}</span>
                            <div className={styles.text}>
                                <div className={styles.labelRow}>
                                    <span className={styles.label}>{step.label}</span>
                                    {step.requiresSignature && (
                                        <span className={styles.signature}>signature</span>
                                    )}
                                </div>
                                {step.description && <p className={styles.description}>{step.description}</p>}
                            </div>
                            <span className={styles.status}>{statusLabel[stepStatus]}</span>
                            <span className={styles.dot} />
                        </div>
                    );
                })}
            </div>
        </section>
    );
};
