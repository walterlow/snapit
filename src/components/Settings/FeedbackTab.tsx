import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, Upload, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export const FeedbackTab: React.FC = () => {
  const [feedback, setFeedback] = useState('');

  const handleSubmitFeedback = () => {
    // TODO: Implement feedback submission
    console.log('Submitting feedback:', feedback);
  };

  const handleUploadLogs = () => {
    // TODO: Implement log upload
    console.log('Uploading logs...');
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
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleSubmitFeedback}
              disabled={!feedback.trim()}
              className="bg-[var(--coral-400)] text-white hover:bg-[var(--coral-500)] disabled:opacity-50"
            >
              <Send className="w-4 h-4 mr-2" />
              Submit Feedback
            </Button>
          </div>
        </div>
      </section>

      {/* Debug Information Section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--coral-400)] mb-3">
          Debug Information
        </h3>
        <div className="p-4 rounded-lg bg-[var(--polar-ice)] border border-[var(--polar-frost)] space-y-4">
          <p className="text-sm text-[var(--ink-muted)]">
            Include application logs to help us diagnose issues faster.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={handleUploadLogs}
              className="bg-[var(--card)] border-[var(--polar-frost)] text-[var(--ink-dark)] hover:bg-[var(--polar-ice)]"
            >
              <Upload className="w-4 h-4 mr-2" />
              Attach Logs
            </Button>
            <Button
              variant="ghost"
              onClick={() => invoke('open_log_dir')}
              className="text-[var(--ink-muted)] hover:text-[var(--ink-black)] hover:bg-[var(--polar-mist)]"
            >
              <FileText className="w-4 h-4 mr-2" />
              View Logs
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
          <div className="grid grid-cols-2 gap-y-3 gap-x-6">
            <div>
              <p className="text-xs text-[var(--ink-muted)] mb-0.5">Operating System</p>
              <p className="text-sm text-[var(--ink-black)]">
                {navigator.platform}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--ink-muted)] mb-0.5">User Agent</p>
              <p className="text-sm text-[var(--ink-black)] truncate" title={navigator.userAgent}>
                {navigator.userAgent.split(' ').slice(-2).join(' ')}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
