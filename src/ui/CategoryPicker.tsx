import { LayoutGroup, motion } from 'motion/react'
import { useId } from 'react'
import type { Category } from '../domain/media'
import { duration, easeOut, useMotionEnabled } from './motion'

interface Props<T extends Category> {
  value: T
  options: readonly T[]
  onChange: (category: T) => void
  label: string
}

export function CategoryPicker<T extends Category>({ value, options, onChange, label }: Props<T>) {
  const groupId = useId()
  const animate = useMotionEnabled()

  return (
    <div className="category-picker" role="group" aria-label={label}>
      <LayoutGroup id={groupId}>
        {options.map((category) => (
          <button key={category} type="button" aria-pressed={category === value} onClick={() => onChange(category)}>
            {category === value ? (
              <motion.span
                className="category-indicator"
                layoutId={animate ? 'selection' : undefined}
                transition={{ duration: duration.filter, ease: easeOut }}
                aria-hidden="true"
              />
            ) : null}
            <span>{category}</span>
          </button>
        ))}
      </LayoutGroup>
    </div>
  )
}
