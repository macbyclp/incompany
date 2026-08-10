import { useId, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from 'react';

/**
 * Form Bileşenleri.
 *
 * Ortak nokta: HER GİRDİNİN BİR `<label>` BAĞI VARDIR.
 *   `placeholder`'ı etiket yerine kullanmak yaygın ama hatalı bir kalıptır:
 *   kullanıcı yazmaya başladığında alanın ne olduğu kaybolur ve ekran
 *   okuyucular placeholder'ı güvenilir biçimde okumaz. `useId` ile üretilen
 *   kimlik, aynı formun iki kez render edilmesi durumunda bile çakışmaz.
 *
 * Hata mesajları `aria-describedby` ve `aria-invalid` ile bağlanır — yalnızca
 * kırmızı çerçeve göstermek renk körü kullanıcılar için yetersizdir.
 */

// --- Alan sarmalayıcı --------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[13px] font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required && <span className="ml-0.5 text-rose-500" aria-hidden="true">*</span>}
      </label>

      {children({ id, describedBy, invalid: Boolean(error) })}

      {error ? (
        <p id={errorId} className="mt-1 text-xs text-rose-600 dark:text-rose-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// --- Girdiler ----------------------------------------------------------------

const inputBase =
  'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 ' +
  'focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ' +
  'dark:bg-slate-800 dark:text-slate-100 dark:disabled:bg-slate-800/50';

const inputTone = (invalid?: boolean) =>
  invalid
    ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20 dark:border-rose-700'
    : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/20 dark:border-slate-600';

export function TextInput({
  invalid,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input {...props} aria-invalid={invalid || undefined} className={`${inputBase} ${inputTone(invalid)} ${className}`} />
  );
}

export function SelectInput({
  invalid,
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select {...props} aria-invalid={invalid || undefined} className={`${inputBase} ${inputTone(invalid)} ${className}`}>
      {children}
    </select>
  );
}

// --- Düğme -------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 dark:disabled:bg-slate-700 dark:disabled:text-slate-500',
  secondary:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-slate-200 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
};

export function Button({
  variant = 'secondary',
  loading,
  children,
  className = '',
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      // `aria-busy`: ekran okuyucu işlemin sürdüğünü bilir. Yalnızca dönen
      // bir simge göstermek görsel olmayan kullanıcılara hiçbir şey söylemez.
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium
                  transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    >
      {loading && (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}

// --- Anahtar (toggle) --------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 py-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800 dark:text-slate-200">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{description}</span>
        )}
      </span>

      <span className="relative shrink-0 pt-0.5">
        {/* Gerçek bir checkbox kullanılır (görsel olarak gizli değil, şeffaf):
            klavye, form semantiği ve ekran okuyucu desteği bedava gelir. */}
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute h-full w-full cursor-pointer opacity-0"
        />
        <span
          className={`block h-5 w-9 rounded-full transition-colors peer-focus-visible:ring-2
                      peer-focus-visible:ring-indigo-500/40 ${
                        checked ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600'
                      }`}
          aria-hidden="true"
        >
          <span
            className={`mt-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              checked ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </span>
      </span>
    </label>
  );
}

// --- Bölüm başlığı -----------------------------------------------------------

export function SettingsSection({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-slate-200 py-5 last:border-b-0 dark:border-slate-800">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h3>
      {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}
