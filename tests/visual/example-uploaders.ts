/**
 * Upload visual regression baselines to GitHub as an artifact.
 *
 * This script runs after a visual regression test fails on a PR, allowing
 * the reviewer to see exactly what broke.
 *
 * Usage:
 * bun tests/visual/example-uploaders.ts <pr-number> <token>
 *
 * The PR number must be provided, and you'll need a personal access token
 * that has permission to create artifacts.
 */

import { chromium, Browser, Page } from '@playwright/test';
import { Octokit } from 'octokit';

async function uploadBaselines(prNumber: string, token: string) {
  if (!prNumber || !token) {
    throw new Error('Usage: bun tests/visual/example-uploaders.ts <pr-number> <token>');
  }

  const octokit = new Octokit({ auth: token });
  const basename = 'visual-regression-baselines';

  // Find the run ID for the visual regression job on this PR
  const runsResponse = await octokit.rest.actions.listWorkflowRuns({
    owner: 'xevrion',
    repo: 'breakscale',
    workflow_id: 2, // Visual regression workflow ID
    head_branch: `pr-${prNumber}`,
    per_page: 1,
  });

  if (!runsResponse.data.workflow_runs.length) {
    throw new Error('No visual regression runs found for this PR');
  }

  const runId = runsResponse.data.workflow_runs[0].id.toString();

  // Get the run ID's artifact ID to upload to
  const artifactsResponse = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner: 'xevrion',
    repo: 'breakscale',
    run_id: runId,
  });

  const workflowArtifactId = artifactsResponse.data.artifacts.find(
    (artifact: any) => artifact.name === basename,
  )?.id;

  if (!workflowArtifactId) {
    throw new Error(
      `Workflow artifact "${basename}" for run ${runId} not found. Make sure visual regression tests ran first.`,
    );
  }

  // Upload a new artifact containing the current baselines
  const fs = await import('fs/promises');

  // The playwright-baselines directory should already exist from the test run
  const baselinesDir = './playwright-baselines';

  try {
    await fs.access(baselinesDir);
  } catch {
    throw new Error(`Baselines directory ${baselinesDir} not found. Run tests first.`);
  }

  const files = await fs.readdir(baselinesDir);

  if (files.length === 0) {
    throw new Error('No baseline files found in playwright-baselines/');
  }

  // Upload each file as a separate artifact entry
  for (const file of files) {
    const path = `${baselinesDir}/${file}`;
    const stat = await fs.stat(path);
    const bytes = await fs.readFile(path);

    // Delete any existing artifact with this name
    await octokit.rest.actions.deleteArtifact({
      owner: 'xevrion',
      repo: 'breakscale',
      artifact_id: workflowArtifactId,
    });

    // Create a new artifact upload
    await octokit.rest.actions.createOrUpdateArtifactFromZip({
      owner: 'xevrion',
      repo: 'breakscale',
      run_id: runId,
      artifact_id: workflowArtifactId,
      name: basename,
      // Note: Upload is done post-upload - this endpoint is for creation only
      // The actual upload requires a multipart upload
    });

    // Upload the file as a separate artifact entry
    await octokit.rest.actions.uploadArtifact({
      owner: 'xevrion',
      repo: 'breakscale',
      run_id: runId,
      artifact_id: workflowArtifactId,
      name: file,
      size: stat.size,
      file: bytes,
    });

    console.log(`✓ Uploaded ${file} (${(bytes.length / 1024).toFixed(2)} KB)`);
  }

  console.log(
    `\n✅ Successfully uploaded ${files.length} baseline artifact(s) to PR #${prNumber}`,
  );
}

// Allow command-line usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const [prNum, token] = process.argv.slice(2);
  uploadBaselines(prNum, token)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Upload failed:', error.message);
      process.exit(1);
    });
} else {
  export { uploadBaselines };
}
