import { join } from 'node:path'

export interface Paths {
  dataDir: string
  dbDir: string
  mediaDir: string
  configDir: string
  registrationsDir: string
  tuwunelTomlPath: string
  appserviceYamlPath: string
  envPath: string
}

export function resolvePaths(dataDir: string): Paths {
  const configDir = join(dataDir, 'config')
  const registrationsDir = join(configDir, 'registrations')
  return {
    dataDir,
    dbDir: join(dataDir, 'db'),
    mediaDir: join(dataDir, 'media'),
    configDir,
    registrationsDir,
    tuwunelTomlPath: join(configDir, 'tuwunel.toml'),
    appserviceYamlPath: join(registrationsDir, 'zooid.yaml'),
    envPath: join(configDir, '.env'),
  }
}
