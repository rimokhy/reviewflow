/* eslint-disable max-lines */

import { Lock } from 'lock';
import { Context } from 'probot';
import { MongoStores } from '../mongo';
import { accountConfigs, Config, defaultConfig } from '../accountConfigs';
// eslint-disable-next-line import/no-cycle
import { autoMergeIfPossible } from '../pr-handlers/actions/autoMergeIfPossible';
import { ExcludesFalsy } from '../utils/ExcludesFalsy';
import { initRepoLabels, LabelResponse, Labels } from './initRepoLabels';
import { obtainAccountContext, AccountContext } from './accountContext';

export interface LockedMergePr {
  id: number;
  number: number;
  branch: string;
}

interface RepoContextWithoutTeamContext<GroupNames extends string> {
  labels: Labels;
  protectedLabelIds: readonly LabelResponse['id'][];

  hasNeedsReview: (labels: LabelResponse[]) => boolean;
  hasRequestedReview: (labels: LabelResponse[]) => boolean;
  hasChangesRequestedReview: (labels: LabelResponse[]) => boolean;
  hasApprovesReview: (labels: LabelResponse[]) => boolean;
  getNeedsReviewGroupNames: (labels: LabelResponse[]) => GroupNames[];

  lockPROrPRS(
    prIdOrIds: string | string[],
    prNumberOrPrNumbers: number | number[],
    callback: () => Promise<void> | void,
  ): Promise<void>;

  getMergeLockedPr(): LockedMergePr;
  addMergeLockPr(pr: LockedMergePr): void;
  removePrFromAutomergeQueue(context: Context<any>, prNumber: number): void;
  reschedule(context: Context<any>, pr: LockedMergePr): void;
  pushAutomergeQueue(pr: LockedMergePr): void;
}

export type RepoContext<GroupNames extends string = any> = AccountContext<
  GroupNames
> &
  RepoContextWithoutTeamContext<GroupNames>;

async function initRepoContext<GroupNames extends string>(
  mongoStores: MongoStores,
  context: Context<any>,
  config: Config<GroupNames>,
): Promise<RepoContext<GroupNames>> {
  const repo = context.payload.repository;
  const org = repo.owner;
  const accountContext = await obtainAccountContext(
    mongoStores,
    context,
    config,
    org,
  );
  const repoContext = Object.create(accountContext);

  const labels = await initRepoLabels(context, config);

  const reviewGroupNames = Object.keys(config.groups) as GroupNames[];

  const needsReviewLabelIds = reviewGroupNames
    .map((key: GroupNames) => config.labels.review[key].needsReview)
    .filter(Boolean)
    .map((name) => labels[name].id);

  const requestedReviewLabelIds = reviewGroupNames
    .map((key) => config.labels.review[key].requested)
    .filter(Boolean)
    .map((name) => labels[name].id);

  const changesRequestedLabelIds = reviewGroupNames
    .map((key) => config.labels.review[key].changesRequested)
    .filter(Boolean)
    .map((name) => labels[name].id);

  const approvedReviewLabelIds = reviewGroupNames
    .map((key) => config.labels.review[key].approved)
    .filter(Boolean)
    .map((name) => labels[name].id);

  const protectedLabelIds = [
    ...requestedReviewLabelIds,
    ...changesRequestedLabelIds,
    ...approvedReviewLabelIds,
  ];

  const labelIdToGroupName = new Map<LabelResponse['id'], GroupNames>();
  reviewGroupNames.forEach((key) => {
    const reviewGroupLabels = config.labels.review[key] as any;
    Object.keys(reviewGroupLabels).forEach((labelKey: string) => {
      labelIdToGroupName.set(labels[reviewGroupLabels[labelKey]].id, key);
    });
  });

  // const updateStatusCheck = (context, reviewGroup, statusInfo) => {};

  const hasNeedsReview = (labels: LabelResponse[]) =>
    labels.some((label) => needsReviewLabelIds.includes(label.id));
  const hasRequestedReview = (labels: LabelResponse[]) =>
    labels.some((label) => requestedReviewLabelIds.includes(label.id));
  const hasChangesRequestedReview = (labels: LabelResponse[]) =>
    labels.some((label) => changesRequestedLabelIds.includes(label.id));
  const hasApprovesReview = (labels: LabelResponse[]) =>
    labels.some((label) => approvedReviewLabelIds.includes(label.id));

  const getNeedsReviewGroupNames = (labels: LabelResponse[]): GroupNames[] =>
    labels
      .filter((label) => needsReviewLabelIds.includes(label.id))
      .map((label) => labelIdToGroupName.get(label.id))
      .filter(ExcludesFalsy);

  const lock = Lock();
  let lockMergePr: LockedMergePr | undefined;
  let automergeQueue: LockedMergePr[] = [];

  const lockPROrPRS = (
    prIdOrIds: string | string[],
    prNumberOrPrNumbers: number | number[],
    callback: () => Promise<void> | void,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const logInfos = {
        repo: repo.full_name,
        prIdOrIds,
        prNumberOrPrNumbers,
      };
      context.log.info('lock: try to lock pr', logInfos);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      lock(prIdOrIds, async (createReleaseCallback) => {
        const release = createReleaseCallback(() => {});
        context.log.info('lock: lock pr acquired', logInfos);
        try {
          await callback();
        } catch (err) {
          context.log.info('lock: release pr (with error)', logInfos);
          release();
          reject(err);
          return;
        }
        context.log.info('lock: release pr', logInfos);
        release();
        resolve();
      });
    });

  const reschedule = (context: Context<any>, pr: LockedMergePr) => {
    if (!pr) throw new Error('Cannot reschedule undefined');
    context.log.info('reschedule', pr);
    setTimeout(() => {
      lockPROrPRS('reschedule', pr.number, () => {
        return lockPROrPRS(String(pr.id), pr.number, async () => {
          const prResult = await context.github.pulls.get(
            context.repo({
              pull_number: pr.number,
            }),
          );
          await autoMergeIfPossible(prResult.data, context, repoContext);
        });
      });
    }, 1000);
  };

  return Object.assign(repoContext, {
    labels,
    protectedLabelIds,
    hasNeedsReview,
    hasRequestedReview,
    hasChangesRequestedReview,
    hasApprovesReview,
    getNeedsReviewGroupNames,

    getMergeLockedPr: () => lockMergePr,
    addMergeLockPr: (pr: LockedMergePr): void => {
      console.log('merge lock: lock', {
        repo: `${repo.owner.login}/${repo.name}`,
        pr,
      });
      if (lockMergePr && String(lockMergePr.number) === String(pr.number)) {
        return;
      }
      if (lockMergePr) throw new Error('Already have lock');
      lockMergePr = pr;
    },
    removePrFromAutomergeQueue: (context, prNumber: number | string): void => {
      context.log(`merge lock: remove ${repo.full_name}#${prNumber}`);
      if (lockMergePr && String(lockMergePr.number) === String(prNumber)) {
        lockMergePr = automergeQueue.shift();
        context.log(`merge lock: next ${repo.full_name}`, lockMergePr);
        if (lockMergePr) {
          reschedule(context, lockMergePr);
        }
      } else {
        automergeQueue = automergeQueue.filter(
          (value) => String(value.number) !== String(prNumber),
        );
      }
    },
    pushAutomergeQueue: (pr: LockedMergePr): void => {
      console.log('merge lock: push queue', {
        repo: repo.full_name,
        pr,
        lockMergePr,
        automergeQueue,
      });
      if (!automergeQueue.some((p) => p.number === pr.number)) {
        automergeQueue.push(pr);
      }
    },
    reschedule,

    lockPROrPRS,
  } as RepoContextWithoutTeamContext<GroupNames>);
}

const repoContextsPromise = new Map<number, Promise<RepoContext>>();
const repoContexts = new Map<number, RepoContext>();

export const shouldIgnoreRepo = (
  repoName: string,
  accountConfig: Config<any, any>,
): boolean => {
  const ignoreRepoRegexp =
    accountConfig.ignoreRepoPattern &&
    new RegExp(`^${accountConfig.ignoreRepoPattern}$`);

  if (repoName === 'reviewflow-test') {
    return process.env.REVIEWFLOW_NAME !== 'reviewflow-test';
  }

  if (ignoreRepoRegexp) {
    return ignoreRepoRegexp.test(repoName);
  }

  return false;
};

export const obtainRepoContext = (
  mongoStores: MongoStores,
  context: Context<any>,
): Promise<RepoContext> | RepoContext | null => {
  const repo = context.payload.repository;
  const owner = repo.owner;
  const key = repo.id;

  const existingRepoContext = repoContexts.get(key);
  if (existingRepoContext) return existingRepoContext;

  const existingPromise = repoContextsPromise.get(key);
  if (existingPromise) return Promise.resolve(existingPromise);

  let accountConfig = accountConfigs[owner.login];

  if (!accountConfig) {
    console.warn(`using default config for ${owner.login}`);
    accountConfig = defaultConfig as Config<any, any>;
  }

  if (shouldIgnoreRepo(repo.name, accountConfig)) {
    console.warn('repo ignored', { owner: repo.owner.login, name: repo.name });
    return null;
  }

  const promise = initRepoContext(mongoStores, context, accountConfig);
  repoContextsPromise.set(key, promise);

  return promise.then((repoContext) => {
    repoContextsPromise.delete(key);
    repoContexts.set(key, repoContext);
    return repoContext;
  });
};
