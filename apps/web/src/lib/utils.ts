import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The class merger every shadcn/ui component imports as `cn`.
 *
 * clsx flattens conditionals; twMerge then resolves Tailwind conflicts so a
 * later class wins — `cn('px-4', 'px-8')` is `px-8` rather than both, which is
 * what makes a component's className prop able to override its own defaults.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
