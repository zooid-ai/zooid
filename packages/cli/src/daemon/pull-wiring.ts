/** Push (`appservice`) binds an inbound listener; pull (`client`) does not. */
export function shouldBindHttpListener(mode: 'appservice' | 'client' | undefined): boolean {
  return mode !== 'client'
}
