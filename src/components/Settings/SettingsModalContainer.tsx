import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsModal } from './SettingsModal';

/**
 * Container component that connects SettingsModal to the settings store.
 * Extracted from App.tsx for better separation of concerns.
 */
export const SettingsModalContainer: React.FC = () => {
  const { settingsModalOpen, closeSettingsModal } = useSettingsStore();
  return (
    <SettingsModal open={settingsModalOpen} onClose={closeSettingsModal} />
  );
};
