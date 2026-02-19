<script lang="ts">
  import { cn } from '../../lib/utils';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLHeadingElement> & { children?: Snippet } = $props();
</script>

<h3
  class={cn('font-semibold leading-none tracking-tight', className)}
  {...restProps}
>
  {@render children?.()}
</h3>
