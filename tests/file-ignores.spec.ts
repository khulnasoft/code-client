import 'jest-extended';

import { collectFilePolicies, parseFileIgnores } from '../src/files';
import { sampleProjectPath, fileIgnoresFixtures, bundleFileIgnores, bundleFilePolicies } from './constants/sample';

describe('file ignores', () => {
  describe('sample-repo', () => {
    it('parses dc ignore file', () => {
      const patterns = parseFileIgnores(`${sampleProjectPath}/.dcignore`);
      expect(patterns).toEqual(bundleFileIgnores.slice(1, 10));
    });

    it('parses dot khulnasoft file', () => {
      const patterns = parseFileIgnores(`${sampleProjectPath}/.khulnasoft`);
      expect(patterns).toEqual(bundleFileIgnores.slice(10));
    });

    it('parses dot khulnasoft file with only one field', () => {
      const patterns = parseFileIgnores(`${sampleProjectPath}/exclude/.khulnasoft`);
      expect(patterns).toEqual(bundleFileIgnores.slice(12));
    });

    it('fails to parse dot khulnasoft file with invalid field', () => {
      expect(() => parseFileIgnores(`${sampleProjectPath}/invalid-dot-khulnasoft/.khulnasoft.invalid`)).toThrow(
        'Please make sure ignore file follows correct syntax',
      );
    });

    it('collects ignore rules', async () => {
      const ignoreRules = await collectFilePolicies([sampleProjectPath]);
      expect(ignoreRules).toEqual(bundleFilePolicies);
    });
  });

  describe('collects correct ignore rules', () => {
    it('from dot khulnasoft files', async () => {
      const collectPath = `${fileIgnoresFixtures}/dot-khulnasoft-excludes`;
      const ignoreRules = await collectFilePolicies([collectPath]);
      expect(ignoreRules).toMatchInlineSnapshot(`
        Object {
          "excludes": Array [
            "${collectPath}/root-excluded/**",
            "${collectPath}/root-excluded",
            "${collectPath}/root-excluded-contents/**",
            "${collectPath}/**/deep-excluded/**",
            "${collectPath}/**/deep-excluded",
            "${collectPath}/**/deep-excluded-contents/**",
            "${collectPath}/sub/root-excluded/**",
            "${collectPath}/sub/root-excluded",
            "${collectPath}/sub/**/deep-excluded/**",
            "${collectPath}/sub/**/deep-excluded",
          ],
          "ignores": Array [
            "**/.git/**",
          ],
        }
      `);
    });

    it('from dot dcignore file', async () => {
      const collectPath = `${fileIgnoresFixtures}/dot-dcignore-rules`;
      const ignoreRules = await collectFilePolicies([collectPath]);
      expect(ignoreRules).toMatchInlineSnapshot(`
        Object {
          "excludes": Array [],
          "ignores": Array [
            "**/.git/**",
            "${collectPath}/root-excluded/**",
            "${collectPath}/root-excluded",
            "${collectPath}/root-excluded-contents/**",
            "${collectPath}/**/deep-excluded/**",
            "${collectPath}/**/deep-excluded",
            "${collectPath}/**/deep-excluded-contents/**",
            "!${collectPath}/not/deep-excluded/**",
            "!${collectPath}/not/deep-excluded",
          ],
        }
      `);
    });

    it('from dot gitignore file', async () => {
      const collectPath = `${fileIgnoresFixtures}/dot-gitignore-rules`;
      const ignoreRules = await collectFilePolicies([collectPath]);
      expect(ignoreRules).toMatchInlineSnapshot(`
        Object {
          "excludes": Array [],
          "ignores": Array [
            "**/.git/**",
            "${collectPath}/root-excluded/**",
            "${collectPath}/root-excluded",
            "${collectPath}/root-excluded-contents/**",
            "${collectPath}/**/deep-excluded/**",
            "${collectPath}/**/deep-excluded",
            "${collectPath}/**/deep-excluded-contents/**",
            "!${collectPath}/not/deep-excluded/**",
            "!${collectPath}/not/deep-excluded",
          ],
        }
      `);
    });

    it('from combined files', async () => {
      const collectPath = `${fileIgnoresFixtures}/combined`;
      const ignoreRules = await collectFilePolicies([collectPath]);
      expect(ignoreRules).toMatchInlineSnapshot(`
        Object {
          "excludes": Array [
            "${collectPath}/khulnasoft-root-excluded/**",
            "${collectPath}/khulnasoft-root-excluded",
            "${collectPath}/**/khulnasoft-deep-excluded/**",
            "${collectPath}/**/khulnasoft-deep-excluded",
            "${collectPath}/sub/khulnasoft-nested-excluded/**",
            "${collectPath}/sub/khulnasoft-nested-excluded",
          ],
          "ignores": Array [
            "**/.git/**",
            "${collectPath}/dcignore-root-excluded/**",
            "${collectPath}/dcignore-root-excluded",
            "${collectPath}/**/dcignore-deep-excluded/**",
            "${collectPath}/**/dcignore-deep-excluded",
            "!${collectPath}/dcignore-root-not-excluded/**",
            "!${collectPath}/dcignore-root-not-excluded",
            "!${collectPath}/**/dcignore-deep-not-excluded/**",
            "!${collectPath}/**/dcignore-deep-not-excluded",
            "${collectPath}/gitignore-root-excluded/**",
            "${collectPath}/gitignore-root-excluded",
            "${collectPath}/**/gitignore-deep-excluded/**",
            "${collectPath}/**/gitignore-deep-excluded",
            "!${collectPath}/gitignore-root-not-excluded/**",
            "!${collectPath}/gitignore-root-not-excluded",
            "!${collectPath}/**/gitignore-deep-not-excluded/**",
            "!${collectPath}/**/gitignore-deep-not-excluded",
          ],
        }
      `);
    });
  });
});
