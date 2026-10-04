import {defineConfig} from '@playwright/test';
import isolated from './seat-actions.config';
export default defineConfig({...isolated,testMatch:['table-events.spec.ts','seat-actions.spec.ts']});
