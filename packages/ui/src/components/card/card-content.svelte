<script lang="ts">
  import { cn } from '../../lib/utils';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    class: className,
    children,
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();
</script>

<div class={cn('p-4 pt-0', className)} {...restProps}>
  {@render children?.()}
</div>
