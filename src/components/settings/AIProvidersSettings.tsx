import React, { useEffect, useState } from 'react';
import { ProviderCard } from './ProviderCard';

export const AIProvidersSettings: React.FC = () => {
    const [openaiApiKey, setOpenaiApiKey] = useState('');
    const [hasStoredOpenAIKey, setHasStoredOpenAIKey] = useState(false);
    const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
    const [testError, setTestError] = useState<string | undefined>();
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        window.electronAPI?.getStoredCredentials?.().then((creds: any) => {
            setHasStoredOpenAIKey(!!creds?.hasOpenaiKey);
        }).catch(() => {});
    }, []);

    const saveOpenAIKey = async () => {
        if (!openaiApiKey.trim()) return;
        setSaving(true);
        try {
            const result = await window.electronAPI?.setOpenaiApiKey?.(openaiApiKey.trim());
            if (result?.success) {
                setHasStoredOpenAIKey(true);
                setSaved(true);
                setOpenaiApiKey('');
                setTimeout(() => setSaved(false), 2000);
            }
        } finally {
            setSaving(false);
        }
    };

    const removeOpenAIKey = async () => {
        if (!confirm('Are you sure you want to remove the OpenAI API key?')) return;
        const result = await window.electronAPI?.setOpenaiApiKey?.('');
        if (result?.success) {
            setHasStoredOpenAIKey(false);
            setOpenaiApiKey('');
        }
    };

    const testOpenAI = async () => {
        if (!openaiApiKey.trim() && !hasStoredOpenAIKey) return;
        setTestStatus('testing');
        setTestError(undefined);
        try {
            const result = await window.electronAPI?.testLlmConnection?.('openai', openaiApiKey.trim());
            if (result?.success) {
                setTestStatus('success');
                setTimeout(() => setTestStatus('idle'), 3000);
            } else {
                setTestStatus('error');
                setTestError(result?.error || 'Connection failed');
            }
        } catch (error: any) {
            setTestStatus('error');
            setTestError(error.message || 'Connection failed');
        }
    };

    return (
        <div className="space-y-5 animated fadeIn pb-10">
            <div>
                <h3 className="text-sm font-bold text-text-primary mb-1">OpenAI Provider</h3>
                <p className="text-xs text-text-secondary mb-2">
                    OpenAI is the only AI provider used for chat, screenshots, meeting summaries, transcription, and embeddings.
                </p>
            </div>

            <ProviderCard
                providerId="openai"
                providerName="OpenAI"
                apiKey={openaiApiKey}
                preferredModel="gpt-5.4"
                hasStoredKey={hasStoredOpenAIKey}
                onKeyChange={setOpenaiApiKey}
                onSaveKey={saveOpenAIKey}
                onRemoveKey={removeOpenAIKey}
                onTestConnection={testOpenAI}
                testStatus={testStatus}
                testError={testError}
                savingStatus={saving}
                savedStatus={saved}
                keyPlaceholder="sk-..."
                keyUrl="https://platform.openai.com/api-keys"
            />
        </div>
    );
};
