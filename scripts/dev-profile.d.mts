export interface DevelopmentEnvironmentOptions {
  repoRoot?: string;
  execPath?: string;
}

export interface DevelopmentEnvironment {
  PIEVO_DATA_DIR: string;
  PIEVO_HOME: string;
  PIEVO_PORT: string;
  PIEVO_BASE_URL: string;
  PIEVO_CLI: string;
}

export function developmentEnvironment(
  env?: NodeJS.ProcessEnv,
  options?: DevelopmentEnvironmentOptions,
): DevelopmentEnvironment;

export function developmentProcessEnvironment(
  fileEnv?: NodeJS.ProcessEnv,
  shellEnv?: NodeJS.ProcessEnv,
  options?: DevelopmentEnvironmentOptions,
): NodeJS.ProcessEnv & DevelopmentEnvironment;
