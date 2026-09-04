// ZOD074. The Dockerfile ARG default IS the pin; docker/versions.json maps each
// ARG name to the npm package it pins (which the Dockerfile only expresses in a
// shell line). collectPins joins the two and refuses to proceed if they disagree.

export interface ImageManifest {
  /** image dir (e.g. "agent-opencode") -> ARG name -> npm package name */
  [imageDir: string]: { [argName: string]: string }
}

export interface Pin {
  imageDir: string
  argName: string
  packageName: string
  version: string
}

export interface OutdatedPin extends Pin {
  latest: string
}

const ARG_LINE = /^[ \t]*ARG[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]*=[ \t]*(.*?))?[ \t]*$/

export function parseDockerfileArgs(text: string): Record<string, string> {
  const args: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = ARG_LINE.exec(line)
    if (m) args[m[1]] = m[2] ?? ''
  }
  return args
}

export function collectPins(
  manifest: ImageManifest,
  dockerfiles: Record<string, string>,
): Pin[] {
  const pins: Pin[] = []
  for (const [imageDir, argMap] of Object.entries(manifest)) {
    const text = dockerfiles[imageDir]
    if (text === undefined) {
      throw new Error(`versions.json names "${imageDir}", which has no Dockerfile`)
    }
    const args = parseDockerfileArgs(text)

    for (const [argName, packageName] of Object.entries(argMap)) {
      const version = args[argName]
      if (version === undefined) {
        throw new Error(`${imageDir}: versions.json names ARG ${argName}, absent from its Dockerfile`)
      }
      if (version === '') {
        throw new Error(`${imageDir}: ARG ${argName} has no default value, so there is no pin`)
      }
      pins.push({ imageDir, argName, packageName, version })
    }

    // The direction that actually bites: a pin nobody indexed is a pin the
    // bumper will never refresh.
    for (const argName of Object.keys(args)) {
      if (argName.endsWith('_VERSION') && !(argName in argMap)) {
        throw new Error(`${imageDir}: ARG ${argName} is not in versions.json`)
      }
    }
  }
  return pins
}

export function findOutdated(pins: Pin[], latest: Record<string, string>): OutdatedPin[] {
  const out: OutdatedPin[] = []
  for (const pin of pins) {
    const current = latest[pin.packageName]
    // No lookup result means the fetch failed or the name is wrong. Staying
    // silent beats reporting a bump we cannot substantiate.
    if (current === undefined) continue
    // Inequality, not ordering: the registry's `latest` dist-tag is definitional.
    if (current !== pin.version) out.push({ ...pin, latest: current })
  }
  return out
}

export function applyPin(text: string, argName: string, version: string): string {
  const pattern = new RegExp(`^([ \\t]*ARG[ \\t]+${argName}[ \\t]*=[ \\t]*).*$`, 'm')
  if (!pattern.test(text)) {
    throw new Error(`ARG ${argName} not found`)
  }
  return text.replace(pattern, `$1${version}`)
}

export function npmLatestUrl(packageName: string): string {
  // A scoped name's slash must be percent-encoded; the @ must not be.
  return `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`
}
