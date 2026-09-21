import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

// Radix wants value/defaultValue as arrays and answers with an array. A bare
// number is the most common slip and crashes the render ("values.map is not a
// function"), so both shapes are accepted and answered in kind.
const toArray = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])

function Slider({ className, defaultValue, value, min = 0, max = 100, onValueChange, onValueCommit, ...props }) {
  const scalar =
    (value !== undefined && !Array.isArray(value)) ||
    (value === undefined && defaultValue !== undefined && !Array.isArray(defaultValue))
  const values = toArray(value) ?? toArray(defaultValue) ?? [min]
  const answer = (fn) => (fn ? (next) => fn(scalar ? next[0] : next) : undefined)

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={toArray(defaultValue)}
      value={toArray(value)}
      min={min}
      max={max}
      onValueChange={answer(onValueChange)}
      onValueCommit={answer(onValueCommit)}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="border-primary ring-ring/50 block size-4 shrink-0 rounded-full border bg-white shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
