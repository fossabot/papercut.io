import type { ThemeChoice } from '../../hooks/useTheme'

const THEME_OPTIONS: Array<{ choice: ThemeChoice; icon: string; label: string }> = [
  { choice: 'light', icon: '☀', label: 'Light theme' },
  { choice: 'system', icon: '◐', label: 'Use system theme' },
  { choice: 'dark', icon: '☾', label: 'Dark theme' },
]

interface ThemeToggleProps {
  choice: ThemeChoice
  onChange: (choice: ThemeChoice) => void
}

export function ThemeToggle({ choice, onChange }: ThemeToggleProps) {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((option) => {
        const active = choice === option.choice
        return (
          <button
            key={option.choice}
            type="button"
            className={'theme-toggle-btn' + (active ? ' theme-toggle-btn-active' : '')}
            aria-pressed={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.choice)}
          >
            <span aria-hidden="true">{option.icon}</span>
          </button>
        )
      })}
    </div>
  )
}
