import { v4 as uuidv4 } from 'uuid';
import pick from 'lodash.pick';
import { gzip } from 'zlib';
import { promisify } from 'util';

import { ErrorCodes, GenericErrorTypes, DEFAULT_ERROR_MESSAGES, MAX_RETRY_ATTEMPTS } from './constants';

import { BundleFiles, SupportedFiles } from './interfaces/files.interface';
import { AnalysisResult, ReportResult } from './interfaces/analysis-result.interface';
import { FailedResponse, makeRequest, Payload } from './needle';
import {
  AnalysisOptions,
  AnalysisContext,
  ReportOptions,
  ScmReportOptions,
} from './interfaces/analysis-options.interface';
import { getURL } from './utils/httpUtils';

type ResultSuccess<T> = { type: 'success'; value: T };
type ResultError<E> = {
  type: 'error';
  error: {
    statusCode: E;
    statusText: string;
    apiName: string;
  };
};

export type Result<T, E> = ResultSuccess<T> | ResultError<E>;

export interface ConnectionOptions {
  baseURL: string;
  sessionToken: string;
  source: string;
  requestId?: string;
  org?: string;
  extraHeaders?: { [key: string]: string };
}

// The trick to typecast union type alias
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isSubsetErrorCode<T>(code: any, messages: { [c: number]: string }): code is T {
  if (code in messages) {
    return true;
  }
  return false;
}

function generateError<E>(
  errorCode: number,
  messages: { [c: number]: string },
  apiName: string,
  error?: string,
): ResultError<E> {
  if (!isSubsetErrorCode<E>(errorCode, messages)) {
    throw { errorCode, messages, apiName };
  }

  const statusCode = errorCode;
  const statusText = error ?? messages[errorCode];

  return {
    type: 'error',
    error: {
      apiName,
      statusCode,
      statusText,
    },
  };
}

type StartSessionResponseDto = {
  readonly draftToken: string;
  readonly loginURL: string;
};

const GENERIC_ERROR_MESSAGES: { [P in GenericErrorTypes]: string } = {
  [ErrorCodes.serverError]: DEFAULT_ERROR_MESSAGES[ErrorCodes.serverError],
  [ErrorCodes.badGateway]: DEFAULT_ERROR_MESSAGES[ErrorCodes.badGateway],
  [ErrorCodes.serviceUnavailable]: DEFAULT_ERROR_MESSAGES[ErrorCodes.serviceUnavailable],
  [ErrorCodes.timeout]: DEFAULT_ERROR_MESSAGES[ErrorCodes.timeout],
  [ErrorCodes.dnsNotFound]: DEFAULT_ERROR_MESSAGES[ErrorCodes.dnsNotFound],
  [ErrorCodes.connectionRefused]: DEFAULT_ERROR_MESSAGES[ErrorCodes.connectionRefused],
};

interface StartSessionOptions {
  readonly authHost: string;
  readonly source: string;
}

export async function compressAndEncode(payload: unknown): Promise<Buffer> {
  // encode payload and compress;
  const deflate = promisify(gzip);
  const compressedPayload = await deflate(Buffer.from(JSON.stringify(payload)).toString('base64'));
  return compressedPayload;
}

export function startSession(options: StartSessionOptions): StartSessionResponseDto {
  const { source, authHost } = options;
  const draftToken = uuidv4();

  return {
    draftToken,
    loginURL: `${authHost}/login?token=${draftToken}&utm_medium=${source}&utm_source=${source}&utm_campaign=${source}&docker=false`,
  };
}

export function getVerifyCallbackUrl(authHost: string): string {
  return `${authHost}/api/verify/callback`;
}

export type IpFamily = 6 | undefined;
/**
 * Dispatches a FORCED IPv6 request to test client's ISP and network capability.
 *
 * @return {number} IP family number used by the client.
 */
export async function getIpFamily(authHost: string): Promise<IpFamily> {
  const family = 6;

  // Dispatch a FORCED IPv6 request to test client's ISP and network capability
  const res = await makeRequest(
    {
      url: getVerifyCallbackUrl(authHost),
      method: 'post',
      family, // family param forces the handler to dispatch a request using IP at "family" version
    },
    0,
  );

  const ipv6Incompatible = (<FailedResponse>res).error;

  return ipv6Incompatible ? undefined : family;
}

type CheckSessionErrorCodes = GenericErrorTypes | ErrorCodes.unauthorizedUser | ErrorCodes.loginInProgress;
const CHECK_SESSION_ERROR_MESSAGES: { [P in CheckSessionErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.loginInProgress]: DEFAULT_ERROR_MESSAGES[ErrorCodes.loginInProgress],
};

interface IApiTokenResponse {
  ok: boolean;
  api: string;
}

interface CheckSessionOptions {
  readonly authHost: string;
  readonly draftToken: string;
  readonly ipFamily?: IpFamily;
}

export async function checkSession(options: CheckSessionOptions): Promise<Result<string, CheckSessionErrorCodes>> {
  const defaultValue: ResultSuccess<string> = {
    type: 'success',
    value: '',
  };

  const res = await makeRequest<IApiTokenResponse>({
    url: getVerifyCallbackUrl(options.authHost),
    body: {
      token: options.draftToken,
    },
    family: options.ipFamily,
    method: 'post',
  });

  if (res.success) {
    return { ...defaultValue, value: (res.body.ok && res.body.api) || '' };
  } else if ([ErrorCodes.loginInProgress, ErrorCodes.badRequest, ErrorCodes.unauthorizedUser].includes(res.errorCode)) {
    return defaultValue;
  }

  return generateError<CheckSessionErrorCodes>(res.errorCode, CHECK_SESSION_ERROR_MESSAGES, 'checkSession');
}

export async function getFilters(
  baseURL: string,
  source: string,
  attempts = MAX_RETRY_ATTEMPTS,
  requestId?: string,
): Promise<Result<SupportedFiles, GenericErrorTypes>> {
  const apiName = 'filters';
  let url: string;

  try {
    url = getURL(baseURL, '/' + apiName, '00000000-0000-0000-0000-00000000');
  } catch (err) {
    return generateError<GenericErrorTypes>(400, err.message, apiName);
  }

  const res = await makeRequest<SupportedFiles>(
    {
      headers: { source, ...(requestId && { 'khulnasoft-request-id': requestId }) },
      url,
      method: 'get',
    },
    attempts,
  );

  if (res.success) {
    return { type: 'success', value: res.body };
  }
  return generateError<GenericErrorTypes>(res.errorCode, GENERIC_ERROR_MESSAGES, apiName);
}

function commonHttpHeaders(options: ConnectionOptions) {
  return {
    Authorization: options.sessionToken,
    source: options.source,
    ...(options.requestId && { 'khulnasoft-request-id': options.requestId }),
    ...(options.org && { 'khulnasoft-org-name': options.org }),
    ...options.extraHeaders,
  };
}

export type RemoteBundle = {
  readonly bundleHash: string;
  readonly missingFiles: string[];
};

export type CreateBundleErrorCodes =
  | GenericErrorTypes
  | ErrorCodes.unauthorizedUser
  | ErrorCodes.unauthorizedBundleAccess
  | ErrorCodes.bigPayload
  | ErrorCodes.badRequest
  | ErrorCodes.notFound;

const CREATE_BUNDLE_ERROR_MESSAGES: { [P in CreateBundleErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.unauthorizedBundleAccess]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedBundleAccess],
  [ErrorCodes.bigPayload]: DEFAULT_ERROR_MESSAGES[ErrorCodes.bigPayload],
  [ErrorCodes.badRequest]: `Request payload doesn't match the specifications`,
  [ErrorCodes.notFound]: 'Unable to resolve requested oid',
};

interface CreateBundleOptions extends ConnectionOptions {
  files: BundleFiles;
}

export async function createBundle(
  options: CreateBundleOptions,
): Promise<Result<RemoteBundle, CreateBundleErrorCodes>> {
  const payloadBody = await compressAndEncode(options.files);
  let url: string;

  try {
    url = getURL(options.baseURL, '/bundle', options.org);
  } catch (err) {
    return generateError<CreateBundleErrorCodes>(400, err.message, 'createBundle');
  }

  const payload: Payload = {
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      ...commonHttpHeaders(options),
    },
    url,
    method: 'post',
    body: payloadBody,
    isJson: false,
  };

  const res = await makeRequest<RemoteBundle>(payload);
  if (res.success) {
    return { type: 'success', value: res.body };
  }
  return generateError<CreateBundleErrorCodes>(res.errorCode, CREATE_BUNDLE_ERROR_MESSAGES, 'createBundle');
}

export type CheckBundleErrorCodes =
  | GenericErrorTypes
  | ErrorCodes.unauthorizedUser
  | ErrorCodes.unauthorizedBundleAccess
  | ErrorCodes.notFound;

const CHECK_BUNDLE_ERROR_MESSAGES: { [P in CheckBundleErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.unauthorizedBundleAccess]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedBundleAccess],
  [ErrorCodes.notFound]: 'Uploaded bundle has expired',
};

interface CheckBundleOptions extends ConnectionOptions {
  bundleHash: string;
}

export async function checkBundle(options: CheckBundleOptions): Promise<Result<RemoteBundle, CheckBundleErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, `/bundle/${options.bundleHash}`, options.org);
  } catch (err) {
    return generateError<CheckBundleErrorCodes>(400, err.message, 'checkBundle');
  }

  const res = await makeRequest<RemoteBundle>({
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'get',
  });

  if (res.success) return { type: 'success', value: res.body };
  return generateError<CheckBundleErrorCodes>(res.errorCode, CHECK_BUNDLE_ERROR_MESSAGES, 'checkBundle');
}

export type ExtendBundleErrorCodes =
  | GenericErrorTypes
  | ErrorCodes.unauthorizedUser
  | ErrorCodes.badRequest
  | ErrorCodes.unauthorizedBundleAccess
  | ErrorCodes.bigPayload
  | ErrorCodes.notFound;

const EXTEND_BUNDLE_ERROR_MESSAGES: { [P in ExtendBundleErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.bigPayload]: DEFAULT_ERROR_MESSAGES[ErrorCodes.bigPayload],
  [ErrorCodes.badRequest]: `Bad request`,
  [ErrorCodes.unauthorizedBundleAccess]: 'Unauthorized access to parent bundle',
  [ErrorCodes.notFound]: 'Parent bundle has expired',
};

interface ExtendBundleOptions extends ConnectionOptions {
  readonly bundleHash: string;
  readonly files: BundleFiles;
  readonly removedFiles?: string[];
}

export async function extendBundle(
  options: ExtendBundleOptions,
): Promise<Result<RemoteBundle, ExtendBundleErrorCodes>> {
  const payloadBody = await compressAndEncode(pick(options, ['files', 'removedFiles']));
  let url: string;

  try {
    url = getURL(options.baseURL, `/bundle/${options.bundleHash}`, options.org);
  } catch (err) {
    return generateError<ExtendBundleErrorCodes>(400, err.message, 'extendBundle');
  }

  const res = await makeRequest<RemoteBundle>({
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      ...commonHttpHeaders(options),
    },
    url,
    method: 'put',
    body: payloadBody,
    isJson: false,
  });
  if (res.success) return { type: 'success', value: res.body };
  return generateError<ExtendBundleErrorCodes>(res.errorCode, EXTEND_BUNDLE_ERROR_MESSAGES, 'extendBundle');
}

// eslint-disable-next-line no-shadow
export enum AnalysisStatus {
  waiting = 'WAITING',
  fetching = 'FETCHING',
  analyzing = 'ANALYZING',
  done = 'DONE',
  failed = 'FAILED',
  complete = 'COMPLETE',
}

export type AnalysisResponseProgress = {
  readonly status: AnalysisStatus.waiting | AnalysisStatus.fetching | AnalysisStatus.analyzing | AnalysisStatus.done;
  readonly progress: number;
};

export type AnalysisFailedResponse = {
  readonly status: AnalysisStatus.failed;
};

export type GetAnalysisResponseDto = AnalysisResult | AnalysisFailedResponse | AnalysisResponseProgress;

export type GetAnalysisErrorCodes =
  | GenericErrorTypes
  | ErrorCodes.unauthorizedUser
  | ErrorCodes.unauthorizedBundleAccess
  | ErrorCodes.badRequest
  | ErrorCodes.notFound;

const GET_ANALYSIS_ERROR_MESSAGES: { [P in GetAnalysisErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.unauthorizedBundleAccess]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedBundleAccess],
  [ErrorCodes.notFound]: DEFAULT_ERROR_MESSAGES[ErrorCodes.notFound],
  [ErrorCodes.badRequest]: DEFAULT_ERROR_MESSAGES[ErrorCodes.badRequest],
  [ErrorCodes.serverError]: 'Getting analysis failed',
};

export interface GetAnalysisOptions extends ConnectionOptions, AnalysisOptions, AnalysisContext {
  bundleHash: string;
}

export async function getAnalysis(
  options: GetAnalysisOptions,
): Promise<Result<GetAnalysisResponseDto, GetAnalysisErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, '/analysis', options.org);
  } catch (err) {
    return generateError<GetAnalysisErrorCodes>(400, err.message, 'getAnalysis');
  }
  const config: Payload = {
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'post',
    body: {
      key: {
        type: 'file',
        hash: options.bundleHash,
        limitToFiles: options.limitToFiles || [],
        ...(options.shard ? { shard: options.shard } : null),
      },
      ...pick(options, ['severity', 'prioritized', 'legacy', 'analysisContext']),
    },
  };

  const res = await makeRequest<GetAnalysisResponseDto>(config);
  if (res.success) return { type: 'success', value: res.body };
  return generateError<GetAnalysisErrorCodes>(res.errorCode, GET_ANALYSIS_ERROR_MESSAGES, 'getAnalysis');
}

export type ReportErrorCodes =
  | GenericErrorTypes
  | ErrorCodes.unauthorizedUser
  | ErrorCodes.unauthorizedBundleAccess
  | ErrorCodes.badRequest
  | ErrorCodes.notFound;

const REPORT_ERROR_MESSAGES: { [P in ReportErrorCodes]: string } = {
  ...GENERIC_ERROR_MESSAGES,
  [ErrorCodes.unauthorizedUser]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedUser],
  [ErrorCodes.unauthorizedBundleAccess]: DEFAULT_ERROR_MESSAGES[ErrorCodes.unauthorizedBundleAccess],
  [ErrorCodes.notFound]: DEFAULT_ERROR_MESSAGES[ErrorCodes.notFound],
  [ErrorCodes.badRequest]: DEFAULT_ERROR_MESSAGES[ErrorCodes.badRequest],
  [ErrorCodes.serverError]: 'Getting report failed',
};

export interface UploadReportOptions extends GetAnalysisOptions {
  report: ReportOptions;
}

export interface ScmUploadReportOptions extends ConnectionOptions, AnalysisOptions, AnalysisContext, ScmReportOptions {}

export interface GetReportOptions extends ConnectionOptions {
  pollId: string;
}

export type InitUploadResponseDto = {
  reportId: string;
};

export type InitScmUploadResponseDto = {
  testId: string;
};

export type UploadReportResponseDto = ReportResult | AnalysisFailedResponse | AnalysisResponseProgress;

/**
 * Trigger a file-based test with reporting.
 */
export async function initReport(options: UploadReportOptions): Promise<Result<string, ReportErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, `/report`, options.org);
  } catch (err) {
    return generateError<ReportErrorCodes>(400, err.message, 'initReport');
  }

  const config: Payload = {
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'post',
    body: {
      workflowData: {
        projectName: options.report.projectName,
        targetName: options.report.targetName,
        targetRef: options.report.targetRef,
        remoteRepoUrl: options.report.remoteRepoUrl,
      },
      key: {
        type: 'file',
        hash: options.bundleHash,
        limitToFiles: options.limitToFiles || [],
        ...(options.shard ? { shard: options.shard } : null),
      },
      ...pick(options, ['severity', 'prioritized', 'legacy', 'analysisContext']),
    },
  };

  const res = await makeRequest<InitUploadResponseDto>(config);
  if (res.success) return { type: 'success', value: res.body.reportId };
  return generateError<ReportErrorCodes>(res.errorCode, REPORT_ERROR_MESSAGES, 'initReport');
}

/**
 * Retrieve a file-based test with reporting.
 */
export async function getReport(options: GetReportOptions): Promise<Result<UploadReportResponseDto, ReportErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, `/report/${options.pollId}`, options.org);
  } catch (err) {
    return generateError<ReportErrorCodes>(400, err.message, 'getReport');
  }

  const config: Payload = {
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'get',
  };

  const res = await makeRequest<UploadReportResponseDto>(config);
  if (res.success) return { type: 'success', value: res.body };
  return generateError<ReportErrorCodes>(res.errorCode, REPORT_ERROR_MESSAGES, 'getReport', res.error?.message);
}

/**
 * Trigger an SCM-based test with reporting.
 */
export async function initScmReport(options: ScmUploadReportOptions): Promise<Result<string, ReportErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, `/test`, options.org);
  } catch (err) {
    return generateError<ReportErrorCodes>(400, err.message, 'initReport');
  }
  const config: Payload = {
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'post',
    body: {
      workflowData: {
        projectId: options.projectId,
        commitHash: options.commitId,
      },
      ...pick(options, ['severity', 'prioritized', 'analysisContext']),
    },
  };

  const res = await makeRequest<InitScmUploadResponseDto>(config);
  if (res.success) return { type: 'success', value: res.body.testId };
  return generateError<ReportErrorCodes>(res.errorCode, REPORT_ERROR_MESSAGES, 'initReport');
}

/**
 * Fetch an SCM-based test with reporting.
 */
export async function getScmReport(
  options: GetReportOptions,
): Promise<Result<UploadReportResponseDto, ReportErrorCodes>> {
  let url: string;

  try {
    url = getURL(options.baseURL, `/test/${options.pollId}`, options.org);
  } catch (err) {
    return generateError<ReportErrorCodes>(400, err.message, 'getReport');
  }

  const config: Payload = {
    headers: {
      ...commonHttpHeaders(options),
    },
    url,
    method: 'get',
  };

  const res = await makeRequest<UploadReportResponseDto>(config);
  if (res.success) return { type: 'success', value: res.body };
  return generateError<ReportErrorCodes>(res.errorCode, REPORT_ERROR_MESSAGES, 'getReport', res.error?.message);
}
