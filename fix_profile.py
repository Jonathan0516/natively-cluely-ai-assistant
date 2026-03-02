import re

with open('src/components/SettingsOverlay.tsx', 'r') as f:
    code = f.read()

# Introduction
old_intro = '''                                    {/* Introduction */}
                                    <div className="mb-8">
                                        <h3 className="text-[22px] font-semibold text-text-primary tracking-tight mb-2 flex items-center gap-3">
                                            Professional Identity
                                            <span className="px-2 py-[2px] rounded-full bg-accent-primary/10 text-accent-primary text-[10px] uppercase tracking-[0.05em] font-medium border border-accent-primary/20 shadow-[inset_0_1px_rgba(255,255,255,0.1)]">Beta</span>
                                        </h3>
                                        <p className="text-[14px] text-text-secondary leading-relaxed max-w-2xl font-normal">
                                            This engine constructs an intelligent representation of your career history. When activated, the AI grounds its logic exclusively in your mapped experience.
                                        </p>
                                    </div>'''

new_intro = '''                                    {/* Introduction */}
                                    <div className="mb-5">
                                        <div className="flex items-center gap-2 mb-1">
                                            <h3 className="text-sm font-bold text-text-primary">Professional Identity</h3>
                                            <span className="bg-accent-primary/10 text-accent-primary text-[9px] font-bold px-1.5 py-0.5 rounded border border-accent-primary/20 uppercase tracking-wide">BETA</span>
                                        </div>
                                        <p className="text-xs text-text-secondary mb-2">
                                            This engine constructs an intelligent representation of your career history.
                                        </p>
                                    </div>'''

code = code.replace(old_intro, new_intro)

# Re-style rounded-[24px]/[20px], fonts, and buttons 
# We'll just replace specific strings that make it look inconsistent.

# Intelligence Graph Hero Card Header
old_intel1 = '''                                    {/* Intelligence Graph Hero Card */}
                                    <div className="relative rounded-[24px] overflow-hidden bg-bg-item-surface bg-gradient-to-br from-bg-subtle/50 to-bg-base">

                                        {/* Glassmorphic Foreground Content */}
                                        <div className="relative z-10 flex flex-col justify-between min-h-[220px]">

                                            {/* Header */}
                                            <div className="p-6 pb-4">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-[52px] h-[52px] rounded-full bg-gradient-to-b from-bg-surface to-bg-input border border-border-subtle flex items-center justify-center text-text-primary shadow-[inset_0_1px_rgba(255,255,255,0.5),0_2px_10px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_rgba(255,255,255,0.1),0_2px_10px_rgba(0,0,0,0.2)] hover:scale-105 transition-transform duration-500">
                                                            <span className="font-semibold text-[20px] tracking-tight">'''

new_intel1 = '''                                    {/* Intelligence Graph Hero Card */}
                                    <div className="bg-bg-item-surface rounded-xl border border-border-subtle flex flex-col justify-between overflow-hidden">
                                        <div className="flex flex-col justify-between min-h-[160px]">

                                            {/* Header */}
                                            <div className="p-5 pb-4">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-10 h-10 rounded-full bg-bg-input border border-border-subtle flex items-center justify-center text-text-primary shadow-sm hover:scale-105 transition-transform duration-300">
                                                            <span className="font-bold text-sm tracking-tight">'''

code = code.replace(old_intel1, new_intel1)

old_intel2 = '''                                                            </span>
                                                        </div>
                                                        <div>
                                                            <h4 className="text-[15px] font-semibold text-text-primary tracking-tight">
                                                                {profileData?.identity?.name || 'Identity Node Inactive'}
                                                            </h4>
                                                            <p className="text-[12px] text-text-secondary mt-0.5 tracking-wide">
                                                                {profileData?.identity?.email || 'Upload a resume to begin mapping.'}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-3">'''

new_intel2 = '''                                                            </span>
                                                        </div>
                                                        <div>
                                                            <h4 className="text-sm font-bold text-text-primary tracking-tight">
                                                                {profileData?.identity?.name || 'Identity Node Inactive'}
                                                            </h4>
                                                            <p className="text-xs text-text-secondary mt-0.5 tracking-wide">
                                                                {profileData?.identity?.email || 'Upload a resume to begin mapping.'}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-3">'''

code = code.replace(old_intel2, new_intel2)

old_toggle = '''                                                        {/* High-fidelity Toggle */}
                                                        <div className="flex items-center gap-3 bg-bg-surface/50 dark:bg-black/30 backdrop-blur-md px-4 py-2 rounded-full border border-border-subtle shadow-sm">
                                                            <span className="text-[12px] font-medium text-text-secondary">Persona Engine</span>
                                                            <button
                                                                onClick={async () => {
                                                                    if (!profileStatus.hasProfile) return;
                                                                    const newState = !profileStatus.profileMode;
                                                                    try {
                                                                        await window.electronAPI?.profileSetMode?.(newState);
                                                                        setProfileStatus(prev => ({ ...prev, profileMode: newState }));
                                                                    } catch (e) {
                                                                        console.error('Failed to toggle profile mode:', e);
                                                                    }
                                                                }}
                                                                className={`w-[36px] h-[20px] rounded-full p-[2px] transition-colors duration-300 shrink-0 ${!profileStatus.hasProfile ? 'bg-bg-input opacity-40 cursor-not-allowed' : profileStatus.profileMode ? 'bg-accent-primary cursor-pointer' : 'bg-bg-input hover:bg-border-subtle cursor-pointer shadow-[inset_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_1px_rgba(0,0,0,0.3)]'}`}
                                                            >
                                                                <div className={`w-[16px] h-[16px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-transform duration-300 ease-in-out ${profileStatus.profileMode ? 'translate-x-[16px]' : 'translate-x-0'}`} />
                                                            </button>
                                                        </div>'''

new_toggle = '''                                                        {/* High-fidelity Toggle */}
                                                        <div className="flex items-center gap-2 bg-bg-input px-3 py-1.5 rounded-lg border border-border-subtle">
                                                            <span className="text-xs font-medium text-text-secondary">Persona Engine</span>
                                                            <div
                                                                onClick={async () => {
                                                                    if (!profileStatus.hasProfile) return;
                                                                    const newState = !profileStatus.profileMode;
                                                                    try {
                                                                        await window.electronAPI?.profileSetMode?.(newState);
                                                                        setProfileStatus(prev => ({ ...prev, profileMode: newState }));
                                                                    } catch (e) {
                                                                        console.error('Failed to toggle profile mode:', e);
                                                                    }
                                                                }}
                                                                className={`w-9 h-5 rounded-full relative transition-colors ${!profileStatus.hasProfile ? 'opacity-40 cursor-not-allowed bg-bg-toggle-switch' : profileStatus.profileMode ? 'bg-accent-primary cursor-pointer' : 'bg-bg-toggle-switch border border-border-muted cursor-pointer'}`}
                                                            >
                                                                <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-white transition-transform ${profileStatus.profileMode ? 'translate-x-4' : 'translate-x-0'}`} />
                                                            </div>
                                                        </div>'''

code = code.replace(old_toggle, new_toggle)

old_metrics = '''                                            {/* Data Metrics & Extracted Skills */}
                                            <div className="p-6 mt-auto">
                                                <div className="grid grid-cols-3 gap-8">
                                                    <div>
                                                        <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                                                            Experience <div className="w-1.5 h-1.5 rounded-full bg-green-500/80" />
                                                        </div>
                                                        <div className="text-[20px] font-medium tracking-tight text-text-primary">
                                                            {profileData?.experienceCount || 0}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                                                            Projects <div className="w-1.5 h-1.5 rounded-full bg-blue-500/80" />
                                                        </div>
                                                        <div className="text-[20px] font-medium tracking-tight text-text-primary">
                                                            {profileData?.projectCount || 0}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                                                            Knowledge Chunks <div className="w-1.5 h-1.5 rounded-full bg-purple-500/80" />
                                                        </div>
                                                        <div className="text-[20px] font-medium tracking-tight text-text-primary">
                                                            {profileData?.nodeCount || 0}
                                                        </div>
                                                    </div>
                                                </div>

                                                {profileData?.skills && profileData.skills.length > 0 && (
                                                    <div className="mt-8">
                                                        <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-3">
                                                            Top Skills
                                                        </div>
                                                        <div className="flex flex-wrap gap-2">
                                                            {profileData.skills.slice(0, 15).map((skill: string, i: number) => (
                                                                <span key={i} className="text-[12px] text-text-secondary px-3 py-1.5 rounded-md border border-border-subtle bg-bg-surface/50 dark:bg-black/20 backdrop-blur-md">
                                                                    {skill}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>'''

new_metrics = '''                                            {/* Data Metrics & Extracted Skills */}
                                            <div className="p-5 pt-0 mt-auto">
                                                <div className="grid grid-cols-3 gap-4">
                                                    <div className="bg-bg-input/30 p-3 rounded-lg border border-border-subtle">
                                                        <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1 flex items-center gap-1.5">
                                                            Experience <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                                        </div>
                                                        <div className="text-xl font-bold tracking-tight text-text-primary">
                                                            {profileData?.experienceCount || 0}
                                                        </div>
                                                    </div>
                                                    <div className="bg-bg-input/30 p-3 rounded-lg border border-border-subtle">
                                                        <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1 flex items-center gap-1.5">
                                                            Projects <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                                                        </div>
                                                        <div className="text-xl font-bold tracking-tight text-text-primary">
                                                            {profileData?.projectCount || 0}
                                                        </div>
                                                    </div>
                                                    <div className="bg-bg-input/30 p-3 rounded-lg border border-border-subtle">
                                                        <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1 flex items-center gap-1.5">
                                                            Knowledge Nodes <div className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                                                        </div>
                                                        <div className="text-xl font-bold tracking-tight text-text-primary">
                                                            {profileData?.nodeCount || 0}
                                                        </div>
                                                    </div>
                                                </div>

                                                {profileData?.skills && profileData.skills.length > 0 && (
                                                    <div className="mt-5">
                                                        <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-2">
                                                            Top Skills
                                                        </div>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {profileData.skills.slice(0, 15).map((skill: string, i: number) => (
                                                                <span key={i} className="text-[10px] font-medium text-text-secondary px-2 py-1 rounded-md border border-border-subtle bg-bg-input">
                                                                    {skill}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>'''

code = code.replace(old_metrics, new_metrics)

old_resume = '''                                    {/* Upload Area - Deep Material */}
                                    <div className="mt-6">
                                        <div className={`relative rounded-[20px] overflow-hidden transition-all duration-300 border ${profileUploading ? 'border-accent-primary/50 shadow-[0_0_0_4px_rgba(var(--color-accent-primary),0.1)]' : 'border-border-subtle bg-bg-item-surface'}`}>
                                            <div className="absolute inset-0 bg-gradient-to-b from-white/40 to-white/10 dark:from-white/5 dark:to-transparent pointer-events-none" />

                                            <div className="relative z-10 p-8 flex items-center justify-between">
                                                <div className="flex items-center gap-5">
                                                    <div className="w-[48px] h-[48px] rounded-2xl bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shadow-[inset_0_1px_rgba(255,255,255,0.5)] dark:shadow-[inset_0_1px_rgba(255,255,255,0.05)]">
                                                        {profileUploading ? <RefreshCw size={22} className="animate-spin text-accent-primary" /> : <Upload size={22} strokeWidth={1.5} />}
                                                    </div>
                                                    <div>
                                                        <h4 className="text-[14px] font-semibold text-text-primary tracking-tight mb-1">
                                                            {profileStatus.hasProfile ? 'Overwrite Source Document' : 'Initialize Knowledge Base'}
                                                        </h4>
                                                        {profileUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-accent-primary rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[11px] text-text-secondary tracking-wide">Processing structural semantics...</span>
                                                            </div>
                                                        ) : (
                                                            <p className="text-[12px] text-text-secondary">
                                                                Provide a structured PDF or DOCX file to seed the intelligence engine.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <button
                                                    onClick={async () => {
                                                        setProfileError('');
                                                        try {
                                                            const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                            if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                            setProfileUploading(true);
                                                            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
                                                            if (result?.success) {
                                                                const status = await window.electronAPI?.profileGetStatus?.();
                                                                if (status) setProfileStatus(status);
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                            } else {
                                                                setProfileError(result?.error || 'Upload failed');
                                                            }
                                                        } catch (e: any) {
                                                            setProfileError(e.message || 'Upload failed');
                                                        } finally {
                                                            setProfileUploading(false);
                                                        }
                                                    }}
                                                    disabled={profileUploading}
                                                    className={`px-5 py-2.5 rounded-full text-[13px] font-medium transition-all duration-300 shadow-sm border border-transparent active:scale-95 ${profileUploading ? 'bg-bg-input text-text-tertiary cursor-wait border-border-subtle' : 'bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 shadow-[0_4px_14px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_14px_rgba(255,255,255,0.1)]'}`}
                                                >
                                                    {profileUploading ? 'Ingesting...' : 'Select File'}
                                                </button>
                                            </div>

                                            {profileError && (
                                                <div className="px-8 pb-5">
                                                    <div className="px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[12px] text-red-500/90 font-medium">
                                                        <X size={14} /> {profileError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>'''

new_resume = '''                                    {/* Upload Area */}
                                    <div className="mt-5">
                                        <div className={`bg-bg-item-surface rounded-xl border transition-all ${profileUploading ? 'border-accent-primary/50 ring-1 ring-accent-primary/20' : 'border-border-subtle'}`}>
                                            <div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary">
                                                        {profileUploading ? <RefreshCw size={20} className="animate-spin text-accent-primary" /> : <Upload size={20} />}
                                                    </div>
                                                    <div>
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5">
                                                            {profileStatus.hasProfile ? 'Overwrite Source Document' : 'Initialize Knowledge Base'}
                                                        </h4>
                                                        {profileUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-accent-primary rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Processing structural semantics...</span>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary">
                                                                Provide a structured PDF or DOCX file to seed the intelligence engine.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <button
                                                    onClick={async () => {
                                                        setProfileError('');
                                                        try {
                                                            const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                            if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                            setProfileUploading(true);
                                                            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
                                                            if (result?.success) {
                                                                const status = await window.electronAPI?.profileGetStatus?.();
                                                                if (status) setProfileStatus(status);
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                            } else {
                                                                setProfileError(result?.error || 'Upload failed');
                                                            }
                                                        } catch (e: any) {
                                                            setProfileError(e.message || 'Upload failed');
                                                        } finally {
                                                            setProfileUploading(false);
                                                        }
                                                    }}
                                                    disabled={profileUploading}
                                                    className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${profileUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-text-primary text-bg-main hover:opacity-90 shadow-sm'}`}
                                                >
                                                    {profileUploading ? 'Ingesting...' : 'Select File'}
                                                </button>
                                            </div>

                                            {profileError && (
                                                <div className="px-5 pb-4">
                                                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium">
                                                        <X size={12} /> {profileError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>'''

code = code.replace(old_resume, new_resume)

old_jd = '''                                    {/* JD Upload Card */}
                                    <div className="mt-4">
                                        <div className={`relative rounded-[20px] overflow-hidden transition-all duration-300 border ${jdUploading ? 'border-blue-500/50 shadow-[0_0_0_4px_rgba(59,130,246,0.1)]' : profileData?.hasActiveJD ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-bg-item-surface'}`}>
                                            <div className="absolute inset-0 bg-gradient-to-b from-white/40 to-white/10 dark:from-white/5 dark:to-transparent pointer-events-none" />

                                            <div className="relative z-10 p-8 flex items-center justify-between">
                                                <div className="flex items-center gap-5">
                                                    <div className="w-[48px] h-[48px] rounded-2xl bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shadow-[inset_0_1px_rgba(255,255,255,0.5)] dark:shadow-[inset_0_1px_rgba(255,255,255,0.05)]">
                                                        {jdUploading ? <RefreshCw size={22} className="animate-spin text-blue-500" /> : <Briefcase size={22} strokeWidth={1.5} />}
                                                    </div>
                                                    <div>
                                                        <h4 className="text-[14px] font-semibold text-text-primary tracking-tight mb-1">
                                                            {profileData?.hasActiveJD ? `${profileData.activeJD?.title} @ ${profileData.activeJD?.company}` : 'Upload Job Description'}
                                                        </h4>
                                                        {jdUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[11px] text-text-secondary tracking-wide">Parsing JD structure...</span>
                                                            </div>
                                                        ) : profileData?.hasActiveJD ? (
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-[11px] text-blue-500 font-medium px-2 py-0.5 bg-blue-500/10 rounded-full">
                                                                    {profileData.activeJD?.level || 'mid'}-level
                                                                </span>
                                                                {profileData.activeJD?.technologies?.slice(0, 3).map((t: string, i: number) => (
                                                                    <span key={i} className="text-[11px] text-text-secondary">{t}</span>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <p className="text-[12px] text-text-secondary">
                                                                Upload a JD to enable persona tuning and company research.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    {profileData?.hasActiveJD && (
                                                        <button
                                                            onClick={async () => {
                                                                await window.electronAPI?.profileDeleteJD?.();
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                                setCompanyDossier(null);
                                                            }}
                                                            className="px-3 py-2 rounded-full text-[12px] text-text-tertiary hover:text-red-500 hover:bg-red-500/5 transition-all"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={async () => {
                                                            setJdError('');
                                                            try {
                                                                const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                                if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                                setJdUploading(true);
                                                                const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
                                                                if (result?.success) {
                                                                    const data = await window.electronAPI?.profileGetProfile?.();
                                                                    if (data) setProfileData(data);
                                                                } else {
                                                                    setJdError(result?.error || 'JD upload failed');
                                                                }
                                                            } catch (e: any) {
                                                                setJdError(e.message || 'JD upload failed');
                                                            } finally {
                                                                setJdUploading(false);
                                                            }
                                                        }}
                                                        disabled={jdUploading}
                                                        className={`px-5 py-2.5 rounded-full text-[13px] font-medium transition-all duration-300 shadow-sm border border-transparent active:scale-95 ${jdUploading ? 'bg-bg-input text-text-tertiary cursor-wait border-border-subtle' : 'bg-blue-600 text-white hover:bg-blue-700 shadow-[0_4px_14px_rgba(59,130,246,0.2)]'}`}
                                                    >
                                                        {jdUploading ? 'Parsing...' : profileData?.hasActiveJD ? 'Replace JD' : 'Upload JD'}
                                                    </button>
                                                </div>
                                            </div>

                                            {jdError && (
                                                <div className="px-8 pb-5">
                                                    <div className="px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[12px] text-red-500/90 font-medium">
                                                        <X size={14} /> {jdError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>'''

new_jd = '''                                    {/* JD Upload Card */}
                                    <div className="mt-5">
                                        <div className={`rounded-xl transition-all border ${jdUploading ? 'border-blue-500/50 ring-1 ring-blue-500/20 bg-bg-item-surface' : profileData?.hasActiveJD ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-bg-item-surface'}`}>
                                            <div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary">
                                                        {jdUploading ? <RefreshCw size={20} className="animate-spin text-blue-500" /> : <Briefcase size={20} />}
                                                    </div>
                                                    <div>
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5 line-clamp-1">
                                                            {profileData?.hasActiveJD ? `${profileData.activeJD?.title} @ ${profileData.activeJD?.company}` : 'Upload Job Description'}
                                                        </h4>
                                                        {jdUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Parsing JD structure...</span>
                                                            </div>
                                                        ) : profileData?.hasActiveJD ? (
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-[9px] font-bold text-blue-500 px-1.5 py-0.5 bg-blue-500/10 rounded uppercase tracking-wide border border-blue-500/20">
                                                                    {profileData.activeJD?.level || 'mid'}-level
                                                                </span>
                                                                <div className="flex gap-1.5">
                                                                    {profileData.activeJD?.technologies?.slice(0, 3).map((t: string, i: number) => (
                                                                        <span key={i} className="text-[10px] text-text-secondary">{t}</span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary">
                                                                Upload a JD to enable persona tuning and company research.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    {profileData?.hasActiveJD && (
                                                        <button
                                                            onClick={async () => {
                                                                await window.electronAPI?.profileDeleteJD?.();
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                                setCompanyDossier(null);
                                                            }}
                                                            className="px-2.5 py-2 rounded-lg text-xs text-text-tertiary hover:text-red-500 hover:bg-red-500/10 transition-all border border-transparent hover:border-red-500/20"
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={async () => {
                                                            setJdError('');
                                                            try {
                                                                const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                                if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                                setJdUploading(true);
                                                                const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
                                                                if (result?.success) {
                                                                    const data = await window.electronAPI?.profileGetProfile?.();
                                                                    if (data) setProfileData(data);
                                                                } else {
                                                                    setJdError(result?.error || 'JD upload failed');
                                                                }
                                                            } catch (e: any) {
                                                                setJdError(e.message || 'JD upload failed');
                                                            } finally {
                                                                setJdUploading(false);
                                                            }
                                                        }}
                                                        disabled={jdUploading}
                                                        className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${jdUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-sm'}`}
                                                    >
                                                        {jdUploading ? 'Parsing...' : profileData?.hasActiveJD ? 'Replace JD' : 'Upload JD'}
                                                    </button>
                                                </div>
                                            </div>

                                            {jdError && (
                                                <div className="px-5 pb-4">
                                                    <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-500 font-medium">
                                                        <X size={12} /> {jdError}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>'''

code = code.replace(old_jd, new_jd)

old_company = '''                                    {/* Company Research Section */}
                                    {profileData?.hasActiveJD && profileData?.activeJD?.company && (
                                        <div className="mt-4">
                                            <div className="relative rounded-[20px] overflow-hidden transition-all duration-300 border border-border-subtle bg-bg-item-surface">
                                                <div className="absolute inset-0 bg-gradient-to-b from-white/40 to-white/10 dark:from-white/5 dark:to-transparent pointer-events-none" />

                                                <div className="relative z-10 p-8">
                                                    <div className="flex items-center justify-between mb-6">
                                                        <div className="flex items-center gap-4">
                                                            <div className="w-[40px] h-[40px] rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
                                                                <Building2 size={20} strokeWidth={1.5} className="text-purple-500" />
                                                            </div>
                                                            <div>
                                                                <h4 className="text-[14px] font-semibold text-text-primary tracking-tight">
                                                                    Company Intel: {profileData.activeJD.company}
                                                                </h4>
                                                                <p className="text-[11px] text-text-secondary mt-0.5">
                                                                    {companyDossier ? 'Research complete' : 'Run research to get hiring strategy, salaries & competitors'}
                                                                </p>
                                                            </div>
                                                        </div>

                                                        <button
                                                            onClick={async () => {
                                                                setCompanyResearching(true);
                                                                try {
                                                                    const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
                                                                    if (result?.success && result.dossier) {
                                                                        setCompanyDossier(result.dossier);
                                                                    }
                                                                } catch (e) {
                                                                    console.error('Research failed:', e);
                                                                } finally {
                                                                    setCompanyResearching(false);
                                                                }
                                                            }}
                                                            disabled={companyResearching}
                                                            className={`px-4 py-2 rounded-full text-[12px] font-medium transition-all duration-300 active:scale-95 flex items-center gap-2 ${companyResearching ? 'bg-bg-input text-text-tertiary cursor-wait' : 'bg-purple-600 text-white hover:bg-purple-700 shadow-[0_4px_14px_rgba(147,51,234,0.2)]'}`}
                                                        >
                                                            {companyResearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                                                            {companyResearching ? 'Researching...' : companyDossier ? 'Refresh' : 'Research Now'}
                                                        </button>
                                                    </div>

                                                    {/* Dossier Results */}
                                                    {companyDossier && (
                                                        <div className="space-y-4">
                                                            {companyDossier.hiring_strategy && (
                                                                <div className="p-4 rounded-xl bg-bg-input/50 border border-border-subtle">
                                                                    <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-2">Hiring Strategy</div>
                                                                    <p className="text-[13px] text-text-secondary leading-relaxed">{companyDossier.hiring_strategy}</p>
                                                                </div>
                                                            )}

                                                            {companyDossier.interview_focus && (
                                                                <div className="p-4 rounded-xl bg-bg-input/50 border border-border-subtle">
                                                                    <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-2">Interview Focus</div>
                                                                    <p className="text-[13px] text-text-secondary leading-relaxed">{companyDossier.interview_focus}</p>
                                                                </div>
                                                            )}

                                                            {companyDossier.salary_estimates?.length > 0 && (
                                                                <div className="p-4 rounded-xl bg-bg-input/50 border border-border-subtle">
                                                                    <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-3">Salary Estimates</div>
                                                                    <div className="space-y-2">
                                                                        {companyDossier.salary_estimates.map((s: any, i: number) => (
                                                                            <div key={i} className="flex items-center justify-between">
                                                                                <span className="text-[13px] text-text-primary">{s.title} ({s.location})</span>
                                                                                <div className="flex items-center gap-2">
                                                                                    <span className="text-[13px] font-medium text-text-primary">
                                                                                        {s.currency} {s.min?.toLocaleString()}-{s.max?.toLocaleString()}
                                                                                    </span>
                                                                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${s.confidence === 'high' ? 'bg-green-500/10 text-green-600' : s.confidence === 'medium' ? 'bg-yellow-500/10 text-yellow-600' : 'bg-red-500/10 text-red-500'}`}>
                                                                                        {s.confidence}
                                                                                    </span>
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {companyDossier.competitors?.length > 0 && (
                                                                <div className="p-4 rounded-xl bg-bg-input/50 border border-border-subtle">
                                                                    <div className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest mb-2">Competitors</div>
                                                                    <div className="flex flex-wrap gap-2">
                                                                        {companyDossier.competitors.map((c: string, i: number) => (
                                                                            <span key={i} className="text-[12px] text-text-secondary px-3 py-1.5 rounded-md border border-border-subtle bg-bg-surface/50">
                                                                                {c}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {companyDossier.sources?.length > 0 && (
                                                                <div className="text-[10px] text-text-tertiary mt-2">
                                                                    Sources: {companyDossier.sources.filter(Boolean).length} references
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}'''

new_company = '''                                    {/* Company Research Section */}
                                    {profileData?.hasActiveJD && profileData?.activeJD?.company && (
                                        <div className="mt-5">
                                            <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5">
                                                <div className="flex items-center justify-between mb-4">
                                                    <div className="flex items-center gap-4">
                                                        <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-purple-500">
                                                            <Building2 size={20} />
                                                        </div>
                                                        <div>
                                                            <h4 className="text-sm font-bold text-text-primary">
                                                                Company Intel: <span className="text-purple-400">{profileData.activeJD.company}</span>
                                                            </h4>
                                                            <p className="text-[11px] text-text-secondary mt-0.5">
                                                                {companyDossier ? 'Research complete' : 'Run research to get hiring strategy, salaries & competitors'}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <button
                                                        onClick={async () => {
                                                            setCompanyResearching(true);
                                                            try {
                                                                const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
                                                                if (result?.success && result.dossier) {
                                                                    setCompanyDossier(result.dossier);
                                                                }
                                                            } catch (e) {
                                                                console.error('Research failed:', e);
                                                            } finally {
                                                                setCompanyResearching(false);
                                                            }
                                                        }}
                                                        disabled={companyResearching}
                                                        className={`px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center gap-2 ${companyResearching ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-purple-600/10 text-purple-500 hover:bg-purple-600/20 border border-purple-500/20'}`}
                                                    >
                                                        {companyResearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                                                        {companyResearching ? 'Researching...' : companyDossier ? 'Refresh' : 'Research Now'}
                                                    </button>
                                                </div>

                                                {/* Dossier Results */}
                                                {companyDossier && (
                                                    <div className="space-y-4 border-t border-border-subtle pt-4 mt-2">
                                                        {companyDossier.hiring_strategy && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1 flex items-center gap-1.5"><Sparkles size={12} className="text-purple-400"/> Hiring Strategy</div>
                                                                <p className="text-xs text-text-secondary leading-relaxed bg-bg-input/50 p-3 rounded-lg border border-border-subtle/50">{companyDossier.hiring_strategy}</p>
                                                            </div>
                                                        )}

                                                        {companyDossier.interview_focus && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1 flex items-center gap-1.5"><MessageSquare size={12} className="text-purple-400"/> Interview Focus</div>
                                                                <p className="text-xs text-text-secondary leading-relaxed bg-bg-input/50 p-3 rounded-lg border border-border-subtle/50">{companyDossier.interview_focus}</p>
                                                            </div>
                                                        )}

                                                        {companyDossier.salary_estimates?.length > 0 && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-1">Salary Estimates</div>
                                                                <div className="space-y-2 bg-bg-input/50 p-3 rounded-lg border border-border-subtle/50">
                                                                    {companyDossier.salary_estimates.map((s: any, i: number) => (
                                                                        <div key={i} className="flex items-center justify-between pb-2 mb-2 border-b border-border-subtle last:border-0 last:pb-0 last:mb-0">
                                                                            <span className="text-xs text-text-primary font-medium">{s.title} <span className="text-text-tertiary">({s.location})</span></span>
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="text-xs font-bold text-green-400">
                                                                                    {s.currency} {s.min?.toLocaleString()} - {s.max?.toLocaleString()}
                                                                                </span>
                                                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${s.confidence === 'high' ? 'bg-green-500/10 text-green-500 border-green-500/20' : s.confidence === 'medium' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                                                                                    {s.confidence.toUpperCase()}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {companyDossier.competitors?.length > 0 && (
                                                            <div>
                                                                <div className="text-[10px] font-bold text-text-primary uppercase tracking-wide mb-2">Competitors</div>
                                                                <div className="flex flex-wrap gap-2">
                                                                    {companyDossier.competitors.map((c: string, i: number) => (
                                                                        <span key={i} className="text-[11px] text-text-secondary px-2.5 py-1 rounded bg-bg-input border border-border-subtle flex items-center gap-1.5">
                                                                            <Building2 size={10} className="text-text-tertiary" /> {c}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}

                                                        {companyDossier.sources?.length > 0 && (
                                                            <div className="text-[10px] text-text-tertiary mt-2">
                                                                Sources: {companyDossier.sources.filter(bool).length} references
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}'''

new_company = new_company.replace("filter(bool)", "filter(Boolean)")
code = code.replace(old_company, new_company)

with open('src/components/SettingsOverlay.tsx', 'w') as f:
    f.write(code)

with open('src/components/profile/ProfileVisualizer.tsx', 'r') as f:
    viz = f.read()

# Make ProfileVisualizer consistent
viz_old1 = '''<div className="relative rounded-[24px] border border-border-subtle bg-white/40 dark:bg-black/20 backdrop-blur-3xl shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_30px_rgba(0,0,0,0.04)] dark:shadow-[inset_0_1px_rgba(255,255,255,0.05),0_8px_30px_rgba(0,0,0,0.2)] p-6">'''
viz_new1 = '''<div className="bg-bg-item-surface rounded-xl p-5 border border-border-subtle">'''
viz = viz.replace(viz_old1, viz_new1)

viz_old2 = '''                    <div className="flex items-center gap-2 mb-8">
                        <span className="p-1.5 rounded-lg bg-green-500/10 text-green-500 border border-green-500/20 shadow-[inset_0_1px_rgba(255,255,255,0.1)]">
                            <Briefcase size={16} />
                        </span>
                        <h3 className="text-[15px] font-semibold text-text-primary tracking-tight">Professional Timeline</h3>
                    </div>'''
viz_new2 = '''                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-8 h-8 rounded-lg bg-green-500/10 text-green-500 border border-green-500/20 flex items-center justify-center">
                            <Briefcase size={14} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Professional Timeline</h3>
                    </div>'''
viz = viz.replace(viz_old2, viz_new2)

viz_old3 = '''                    <div className="flex items-center gap-2 mb-6">
                        <span className="p-1.5 rounded-lg bg-blue-500/10 text-blue-500 border border-blue-500/20 shadow-[inset_0_1px_rgba(255,255,255,0.1)]">
                            <Code size={16} />
                        </span>
                        <h3 className="text-[15px] font-semibold text-text-primary tracking-tight">Featured Projects</h3>
                    </div>'''
viz_new3 = '''                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-500 border border-blue-500/20 flex items-center justify-center">
                            <Code size={14} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Featured Projects</h3>
                    </div>'''
viz = viz.replace(viz_old3, viz_new3)

viz_old4 = '''                    <div className="flex items-center gap-2 mb-6">
                        <span className="p-1.5 rounded-lg bg-orange-500/10 text-orange-500 border border-orange-500/20 shadow-[inset_0_1px_rgba(255,255,255,0.1)]">
                            <GraduationCap size={16} />
                        </span>
                        <h3 className="text-[15px] font-semibold text-text-primary tracking-tight">Academic Background</h3>
                    </div>'''
viz_new4 = '''                    <div className="flex items-center gap-3 mb-5">
                        <div className="w-8 h-8 rounded-lg bg-orange-500/10 text-orange-500 border border-orange-500/20 flex items-center justify-center">
                            <GraduationCap size={14} />
                        </div>
                        <h3 className="text-sm font-bold text-text-primary">Academic Background</h3>
                    </div>'''
viz = viz.replace(viz_old4, viz_new4)

viz_proj = '''className="p-5 rounded-[16px] border border-white/10 dark:border-white/5 bg-white/50 dark:bg-black/30 flex flex-col group hover:bg-white/60 dark:hover:bg-black/40 transition-colors shadow-sm"'''
viz_proj_new = '''className="p-4 rounded-lg border border-border-subtle bg-bg-input/50 flex flex-col transition-colors"'''
viz = viz.replace(viz_proj, viz_proj_new)

with open('src/components/profile/ProfileVisualizer.tsx', 'w') as f:
    f.write(viz)

