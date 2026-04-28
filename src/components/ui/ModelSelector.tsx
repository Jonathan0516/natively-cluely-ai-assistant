import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud } from 'lucide-react';

interface ModelSelectorProps {
    currentModel: string;
    onSelectModel: (model: string) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onSelectModel }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const modelId = 'gpt-5.4';

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleSelect = () => {
        onSelectModel(modelId);
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle rounded-lg transition-colors text-xs font-medium text-text-primary max-w-[150px]"
            >
                <span className="truncate">{currentModel === modelId ? 'GPT 5.4' : 'GPT 5.4'}</span>
                <ChevronDown size={14} className={`shrink-0 text-text-secondary transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-64 bg-bg-item-surface border border-border-subtle rounded-xl shadow-xl z-50 overflow-hidden animated fadeIn">
                    <div className="p-2">
                        <button
                            onClick={handleSelect}
                            className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-colors ${currentModel === modelId ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-input text-text-primary'}`}
                        >
                            <div className="w-8 h-8 rounded-lg bg-bg-input flex items-center justify-center text-text-secondary">
                                <Cloud size={14} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium truncate">GPT 5.4</div>
                                <div className="text-[10px] text-text-tertiary truncate">OpenAI</div>
                            </div>
                            {currentModel === modelId && <Check size={14} className="shrink-0" />}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
