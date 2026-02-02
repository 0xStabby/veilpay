import type { FC } from 'react';
import styles from './FlowStepsModal.module.css';
import { FlowSteps } from './FlowSteps';
import type { FlowStep, FlowStepStatus } from '../../lib/flowSteps';

type FlowStepsModalProps = {
    open: boolean;
    title: string;
    steps: FlowStep[];
    status: Record<string, FlowStepStatus>;
    onClose?: () => void;
    allowClose?: boolean;
};

export const FlowStepsModal: FC<FlowStepsModalProps> = ({
    open,
    title,
    steps,
    status,
    onClose,
    allowClose = true,
}) => {
    if (!open) return null;
    return (
        <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={title}>
            <div className={styles.modal}>
                <header className={styles.header}>
                    <div>
                        <p className={styles.kicker}>Working</p>
                        <h3>{title}</h3>
                    </div>
                    <button
                        type="button"
                        className={styles.close}
                        onClick={onClose}
                        disabled={!allowClose}
                        aria-label="Close"
                    >
                        Close
                    </button>
                </header>
                <FlowSteps title="" steps={steps} status={status} />
            </div>
        </div>
    );
};
