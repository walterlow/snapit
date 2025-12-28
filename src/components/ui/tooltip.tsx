import * as React from "react"
import { Tooltip } from "@base-ui/react/tooltip"
import { cn } from "@/lib/utils"

// Wrapper to maintain compatibility with Radix API
interface TooltipProviderProps {
  children: React.ReactNode
  delayDuration?: number
  skipDelayDuration?: number
}

const TooltipProvider: React.FC<TooltipProviderProps> = ({ 
  children, 
  delayDuration = 300,
  skipDelayDuration = 300 
}) => (
  <Tooltip.Provider delay={delayDuration} timeout={skipDelayDuration}>
    {children}
  </Tooltip.Provider>
)

const TooltipRoot = Tooltip.Root

const TooltipTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Tooltip.Trigger> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => {
  if (asChild && React.isValidElement(children)) {
    return (
      <Tooltip.Trigger
        ref={ref}
        className={className}
        render={children}
        {...props}
      />
    )
  }
  return (
    <Tooltip.Trigger ref={ref} className={className} {...props}>
      {children}
    </Tooltip.Trigger>
  )
})
TooltipTrigger.displayName = "TooltipTrigger"

interface TooltipContentProps extends React.HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  ({ className, side = "top", sideOffset = 4, children, ...props }, ref) => (
    <Tooltip.Portal>
      <Tooltip.Positioner side={side} sideOffset={sideOffset} className="z-9999">
        <Tooltip.Popup
          ref={ref}
          className={cn(
            "overflow-hidden rounded-lg bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg",
            className
          )}
          {...props}
        >
          {children}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  )
)
TooltipContent.displayName = "TooltipContent"

export { 
  TooltipRoot as Tooltip, 
  TooltipTrigger, 
  TooltipContent, 
  TooltipProvider 
}
