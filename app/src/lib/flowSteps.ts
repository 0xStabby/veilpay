export type FlowStepStatus = 'idle' | 'running' | 'success' | 'error';

export type FlowStep = {
    id: string;
    label: string;
    description?: string;
    requiresSignature?: boolean;
};

export type FlowStepHandler = (stepId: string, status: FlowStepStatus, message?: string) => void;

export const initStepStatus = (steps: FlowStep[]): Record<string, FlowStepStatus> => {
    const entries = steps.map((step) => [step.id, 'idle' as FlowStepStatus]);
    return Object.fromEntries(entries);
};
