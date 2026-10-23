import { killServer } from './server';

export default async function globalTeardown(): Promise<void> {
  await killServer();
}
