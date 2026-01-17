import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { FileText, Upload, Send, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { settingsLogger } from '@/utils/logger';

const FEEDBACK_API = 'https://snapit-feedback.walterlow88.workers.dev/feedback';

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error';

export const FeedbackTab: React.FC = () => {
  const [feedback, setFeedback] = useState('');
  const [attachedLogs, setAttachedLogs] = useState<string | null>(null);
  const [isAttachingLogs, setIsAttachingLogs] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  const handleSubmitFeedback = async () => {
    if (!feedback.trim()) return;

    setSubmitStatus('submitting');
    setErrorMessage('');

    try {
      const response = await fetch(FEEDBACK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: feedback,
          logs: attachedLogs,
          systemInfo: {
            platform: 'Windows',
          },
          appVersion,
        }),
      });

      if (response.ok) {
        setSubmitStatus('success');
        setFeedback('');
        setAttachedLogs(null);
        setTimeout(() => setSubmitStatus('idle'), 3000);
      } else {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Server responded with ${response.status}`);
      }
    } catch (error) {
      setSubmitStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to submit feedback');
      setTimeout(() => setSubmitStatus('idle'), 5000);
    }
  };

  const handleAttachLogs = async () => {
    setIsAttachingLogs(true);
    try {
      const logs = await invoke<string>('get_recent_logs', { lines: 500 });
      setAttachedLogs(logs);
    } catch (error) {
      settingsLogger.error('Failed to attach logs:', error);
    } finally {
      setIsAttachingLogs(false);
    }
  };

  const handleRemoveLogs = () => {
    setAttachedLogs(null);
  };

  const getSubmitButtonContent = () => {
    switch (submitStatus) {
      case 'submitting':
        return (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Sending...
          </>
        );
      case 'success':
        return (
          <>
            <Check className="w-4 h-4 mr-2" />
            Sent!
          </>
        );
      case 'error':
        return (
          <>
            <X className="w-4 h-4 mr-2" />
            Failed
          </>
        );
      default:
        return (
          <>
            <Send className="w-4 h-4 mr-2" />
            Submit Feedback
          </>
        );
    }
  };

  const getSubmitButtonClass = () => {
    switch (submitStatus) {
      case 'success':
        return 'bg-emerald-500 text-white hover:bg-emerald-600';
      case 'error':
        return 'bg-red-500 text-white hover:bg-red-600';
      default:
        return 'bg-[var(--coral-400)] text-white hover:bg-[var(--coral-500)]';
    }
  };

  return (
    <div className="space-y-6">
      {/* Feedback Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Send Feedback
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          <div>
            <label className="text-sm text-[var(--ink-black)] mb-2 block">
              Tell us what you think
            </label>
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Describe your feedback, suggestions, or report an issue..."
              className="min-h-[120px] bg-[var(--card)] border-[var(--polar-frost)] text-[var(--ink-black)] placeholder:text-[var(--ink-muted)] resize-none"
              disabled={submitStatus === 'submitting'}
            />
          </div>

          {/* Error message */}
          {submitStatus === 'error' && errorMessage && (
            <p className="text-sm text-red-500">{errorMessage}</p>
          )}

          <div className="flex items-center justify-between">
            {/* Logs attachment */}
            <div className="flex items-center gap-2">
              {attachedLogs ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                  <Check className="w-4 h-4" />
                  <span>Logs attached</span>
                  <button
                    onClick={handleRemoveLogs}
                    className="text-[var(--ink-muted)] hover:text-red-500 transition-colors"
                    title="Remove logs"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAttachLogs}
                  disabled={isAttachingLogs}
                  className="text-[var(--ink-muted)] hover:text-[var(--ink-black)] h-8 px-2"
                >
                  {isAttachingLogs ? (
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-1.5" />
                  )}
                  {isAttachingLogs ? 'Attaching...' : 'Attach logs'}
                </Button>
              )}
            </div>

            <Button
              onClick={handleSubmitFeedback}
              disabled={!feedback.trim() || submitStatus === 'submitting'}
              className={`${getSubmitButtonClass()} disabled:opacity-50 transition-colors`}
            >
              {getSubmitButtonContent()}
            </Button>
          </div>
        </div>
      </section>

      {/* System Information Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          System Information
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)]">
          <p className="text-xs text-[var(--ink-muted)] mb-3">
            This information is included with your feedback to help us diagnose issues.
          </p>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-[var(--ink-muted)]">Platform:</span>{' '}
              <span className="text-[var(--ink-black)]">Windows</span>
            </div>
            <div>
              <span className="text-[var(--ink-muted)]">Version:</span>{' '}
              <span className="text-[var(--ink-black)]">{appVersion || '...'}</span>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-[var(--polar-frost)]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => invoke('open_log_dir')}
              className="text-[var(--ink-muted)] hover:text-[var(--ink-black)] h-8 px-2"
            >
              <FileText className="w-4 h-4 mr-1.5" />
              View logs folder
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};
