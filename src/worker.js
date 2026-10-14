const APP_NAME = "종합감사 디지털 사례집";
const SERVICE_NAME = "audit-casebook";
const APP_VERSION = "0.11.0";

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_ASK_LENGTH = 2000;
const MAX_ASK_CONTEXT_LENGTH = 12000;
const ASK_TIMEOUT_MS = 60000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ask") {
      if (request.method !== "POST") {
        return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED",
          message: "질문은 POST 요청으로 보내 주세요." }, 405, { Allow: "POST" });
      }
      return proxyAuditAsk(request, env);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        {
          success: false,
          error: "METHOD_NOT_ALLOWED",
          message: "현재는 GET 요청만 지원합니다.",
        },
        405,
        {
          Allow: "GET, HEAD",
        }
      );
    }

    if (url.pathname === "/health") {
      const bindingConfigured = hasAuditServiceBinding(env);

      return jsonResponse({
        success: true,
        status: "ok",
        service: SERVICE_NAME,
        version: APP_VERSION,
        auditServiceBindingConfigured: bindingConfigured,
        searchProxyAvailable: true,
        searchPageAvailable: true,
        resultCardsAvailable: true,
        caseDetailAvailable: true,
        structuredTablesAvailable: true,
        tableLayoutRepairAvailable: true,
        yearFilterAvailable: true,
        yearOptionsAvailable: true,
        dispositionFilterAvailable: true,
        dispositionFilterMode: "category_and_type",
        statisticsPageAvailable: true,
        statisticsApiAvailable: true,
        categoryDonutAvailable: true,
        categoryDonutLabelsAvailable: true,
        customGptAvailable: false,
        customGptClipboardAvailable: false,
        analysisChatAvailable: bindingConfigured,
        message: bindingConfigured
          ? "검색, 상세보기, 필터 및 통계 화면이 정상 설정되어 있습니다."
          : "웹페이지는 작동하지만 AUDIT_SERVICE Binding이 없습니다.",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/health") {
      return checkAuditService(env);
    }

    if (url.pathname === "/api/search") {
      return proxyAuditSearch(url, env);
    }

    if (url.pathname === "/api/years") {
      return proxyAuditYears(env);
    }

    if (url.pathname === "/api/statistics") {
      return proxyAuditStatistics(env);
    }

    if (url.pathname === "/api/detail") {
      return proxyAuditDetail(url, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return htmlResponse(getHomePage());
    }

    if (url.pathname === "/statistics") {
      return htmlResponse(getStatisticsPage());
    }

    return jsonResponse(
      {
        success: false,
        error: "NOT_FOUND",
        message: "요청한 페이지를 찾을 수 없습니다.",
        path: url.pathname,
      },
      404
    );
  },
};

async function checkAuditService(env) {
  if (!hasAuditServiceBinding(env)) {
    return serviceBindingMissingResponse();
  }

  try {
    const upstreamResponse = await env.AUDIT_SERVICE.fetch(
      new Request("https://audit2026.internal/health", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
    );

    const upstreamResult = await parseUpstreamJson(upstreamResponse);

    if (!upstreamResult.validJson) {
      return invalidUpstreamResponse(
        "audit2026의 상태 응답이 올바른 JSON 형식이 아닙니다.",
        upstreamResponse,
        upstreamResult
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "AUDIT_SERVICE_ERROR",
          message: "audit2026에서 오류 응답을 반환했습니다.",
          upstreamStatus: upstreamResponse.status,
          auditService: upstreamResult.data,
        },
        502
      );
    }

    return jsonResponse({
      success: true,
      status: "ok",
      service: SERVICE_NAME,
      version: APP_VERSION,
      auditServiceConnected: true,
      upstreamStatus: upstreamResponse.status,
      auditService: upstreamResult.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return connectionFailureResponse(
      "AUDIT_SERVICE_CONNECTION_FAILED",
      "audit2026 Service Binding 호출 중 오류가 발생했습니다.",
      error
    );
  }
}

async function proxyAuditSearch(url, env) {
  if (!hasAuditServiceBinding(env)) {
    return serviceBindingMissingResponse();
  }

  const query = (url.searchParams.get("q") || "").trim();
  const limitValue = url.searchParams.get("limit");
  const yearValue = (url.searchParams.get("year") || "").trim();
  const dispositionCategoryValue = (
    url.searchParams.get("dispositionCategory") || ""
  ).trim();
  const dispositionTypeValue = (
    url.searchParams.get("dispositionType") || ""
  ).trim();

  if (!query) {
    return jsonResponse(
      {
        success: false,
        error: "QUERY_REQUIRED",
        message: "검색어를 입력해 주세요.",
      },
      400
    );
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return jsonResponse(
      {
        success: false,
        error: "QUERY_TOO_LONG",
        message: `검색어는 ${MAX_QUERY_LENGTH}자 이하로 입력하세요.`,
      },
      400
    );
  }

  const limitResult = parseSearchLimit(limitValue);

  if (!limitResult.valid) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_LIMIT",
        message: `limit은 1부터 ${MAX_SEARCH_LIMIT}까지의 정수여야 합니다.`,
      },
      400
    );
  }

  const yearResult = parseYearFilter(yearValue);

  if (!yearResult.valid) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_YEAR",
        message: "연도는 4자리 숫자로 입력해야 합니다.",
      },
      400
    );
  }

  const dispositionResult = parseDispositionFilter(
    dispositionCategoryValue,
    dispositionTypeValue
  );

  if (!dispositionResult.valid) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_DISPOSITION_FILTER",
        message: dispositionResult.message,
      },
      400
    );
  }

  try {
    const upstreamUrl = new URL(
      "https://audit2026.internal/search-fast"
    );

    upstreamUrl.searchParams.set("q", query);
    upstreamUrl.searchParams.set(
      "limit",
      String(limitResult.value)
    );

    if (yearResult.value !== null) {
      upstreamUrl.searchParams.set(
        "year",
        String(yearResult.value)
      );
    }

    if (dispositionResult.category) {
      upstreamUrl.searchParams.set(
        "dispositionCategory",
        dispositionResult.category
      );
    }

    if (dispositionResult.type) {
      upstreamUrl.searchParams.set(
        "dispositionType",
        dispositionResult.type
      );
    }

    const upstreamResponse = await env.AUDIT_SERVICE.fetch(
      new Request(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
    );

    const upstreamResult = await parseUpstreamJson(upstreamResponse);

    if (!upstreamResult.validJson) {
      return invalidUpstreamResponse(
        "audit2026의 검색 응답이 올바른 JSON 형식이 아닙니다.",
        upstreamResponse,
        upstreamResult
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "AUDIT_SEARCH_ERROR",
          message: "audit2026 검색 중 오류가 발생했습니다.",
          upstreamStatus: upstreamResponse.status,
          auditService: upstreamResult.data,
        },
        502
      );
    }

    return jsonResponse(upstreamResult.data, 200, {
      "X-Audit-Casebook-Proxy": "search-fast",
    });
  } catch (error) {
    return connectionFailureResponse(
      "AUDIT_SEARCH_CONNECTION_FAILED",
      "audit2026 검색 호출 중 오류가 발생했습니다.",
      error
    );
  }
}

async function proxyAuditAsk(request, env) {
  // Only the same-origin UI may submit browser requests to this endpoint.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ success: false, error: "ORIGIN_NOT_ALLOWED",
      message: "이 페이지에서 질문을 보내 주세요." }, 403);
  }
  if (!hasAuditServiceBinding(env)) return serviceBindingMissingResponse();
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return jsonResponse({ success: false, error: "INVALID_CONTENT_TYPE",
      message: "질문을 JSON 형식으로 보내 주세요." }, 415);
  }

  let body;
  try {
    // Bound streamed input as well as requests without Content-Length.
    const reader = request.body?.getReader();
    if (!reader) throw new Error("EMPTY_BODY");
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 100000) {
        await reader.cancel();
        return jsonResponse({ success: false, error: "REQUEST_TOO_LARGE",
          message: "질문과 대화 내용이 너무 깁니다. 새 대화를 시작해 주세요." }, 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse({ success: false, error: "INVALID_JSON",
      message: "질문 요청을 읽을 수 없습니다." }, 400);
  }

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  const context = body?.context ?? "";
  const history = body?.history ?? [];
  if (!question || question.length > MAX_ASK_LENGTH) {
    return jsonResponse({ success: false, error: "INVALID_QUESTION",
      message: `질문은 1~${MAX_ASK_LENGTH}자로 입력해 주세요.` }, 400);
  }
  if (typeof context !== "string" || context.length > MAX_ASK_CONTEXT_LENGTH ||
      !Array.isArray(history) || history.length > 6 || history.some(item =>
        !item || !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" || item.content.length > 2000)) {
    return jsonResponse({ success: false, error: "INVALID_CHAT_CONTEXT",
      message: "대화 내용이 너무 길거나 형식이 올바르지 않습니다." }, 400);
  }

  const prompt = [
    "현재 질문에 한국어로 답변하세요. 이전 대화는 후속 질문을 이해하는 참고 자료입니다.",
    "선택한 사례와 검색된 사례를 구분하고, 확인할 수 없는 근거는 확인 불가라고 표시하세요.",
    context ? "[선택한 검색 주제 또는 사례]\n" + context : "",
    history.length ? "[이전 대화]\n" + history.map(item =>
      (item.role === "user" ? "사용자: " : "답변: ") + item.content).join("\n\n") : "",
    "[현재 질문]\n" + question
  ].filter(Boolean).join("\n\n");
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("ASK_TIMEOUT"));
      }, ASK_TIMEOUT_MS);
    });
    const upstreamResult = await Promise.race([
      (async () => {
        // The existing POST tool endpoint avoids placing questions in URLs.
        const response = await env.AUDIT_SERVICE.fetch(new Request(
          "https://audit2026.internal/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ tool: "ask_audit_cases", arguments: { query: prompt } }),
            signal: controller.signal
          }
        ));
        return { response, parsed: await parseUpstreamJson(response) };
      })(), timeout
    ]);
    const { response, parsed } = upstreamResult;
    if (!response.ok || !parsed.validJson || parsed.data?.ok !== true ||
        parsed.data?.raw?.success === false || typeof parsed.data?.answer !== "string" ||
        !parsed.data.answer.trim()) {
      return jsonResponse({ success: false, error: "AUDIT_ASK_ERROR",
        message: "답변을 생성하지 못했습니다. 잠시 후 다시 질문해 주세요." }, 502);
    }
    const sources = Array.isArray(parsed.data.sources) ? parsed.data.sources : [];
    return jsonResponse({ success: true, answer: parsed.data.answer,
      sources: sources.slice(0, 3).map(item => ({
        title: String(item?.title || "제목 없음"),
        year: item?.year == null ? null : String(item.year),
        sourceFile: String(item?.source_file || item?.sourceFile || "")
      })) });
  } catch {
    return jsonResponse({ success: false, error: timedOut ? "ASK_TIMEOUT" : "AUDIT_ASK_CONNECTION_FAILED",
      message: timedOut ? "답변 생성 시간이 길어지고 있습니다. 질문을 줄여 다시 시도해 주세요."
        : "분석 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }, timedOut ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

async function proxyAuditYears(env) {
  if (!hasAuditServiceBinding(env)) {
    return serviceBindingMissingResponse();
  }

  try {
    const upstreamResponse = await env.AUDIT_SERVICE.fetch(
      new Request("https://audit2026.internal/cases-summary", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
    );

    const upstreamResult = await parseUpstreamJson(upstreamResponse);

    if (!upstreamResult.validJson) {
      return invalidUpstreamResponse(
        "audit2026의 연도 통계 응답이 올바른 JSON 형식이 아닙니다.",
        upstreamResponse,
        upstreamResult
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "AUDIT_YEARS_ERROR",
          message: "audit2026 연도 목록 조회 중 오류가 발생했습니다.",
          upstreamStatus: upstreamResponse.status,
        },
        502
      );
    }

    const rawYearStats = Array.isArray(
      upstreamResult.data?.yearStats
    )
      ? upstreamResult.data.yearStats
      : [];

    const years = rawYearStats
      .map((item) => ({
        year: String(item?.year || "").trim(),
        count: Number(item?.count || 0),
      }))
      .filter(
        (item) =>
          /^\d{4}$/.test(item.year) &&
          Number.isFinite(item.count) &&
          item.count >= 0
      )
      .sort((a, b) => Number(b.year) - Number(a.year));

    return jsonResponse({
      success: true,
      years,
      yearCount: years.length,
      totalCases:
        Number(
          upstreamResult.data?.summary?.totalCases ||
          upstreamResult.data?.summary?.totalPoints ||
          0
        ) || 0,
    });
  } catch (error) {
    return connectionFailureResponse(
      "AUDIT_YEARS_CONNECTION_FAILED",
      "audit2026 연도 목록 호출 중 오류가 발생했습니다.",
      error
    );
  }
}

async function proxyAuditDetail(url, env) {
  if (!hasAuditServiceBinding(env)) {
    return serviceBindingMissingResponse();
  }

  const caseId = (url.searchParams.get("id") || "").trim();

  if (!caseId) {
    return jsonResponse(
      {
        success: false,
        error: "CASE_ID_REQUIRED",
        message: "상세조회할 사례 ID가 필요합니다.",
      },
      400
    );
  }

  if (!/^[A-Za-z0-9_-]{1,100}$/.test(caseId)) {
    return jsonResponse(
      {
        success: false,
        error: "INVALID_CASE_ID",
        message: "사례 ID 형식이 올바르지 않습니다.",
      },
      400
    );
  }

  try {
    const upstreamUrl = new URL(
      "https://audit2026.internal/case-detail"
    );

    upstreamUrl.searchParams.set("id", caseId);

    const upstreamResponse = await env.AUDIT_SERVICE.fetch(
      new Request(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
    );

    const upstreamResult = await parseUpstreamJson(upstreamResponse);

    if (!upstreamResult.validJson) {
      return invalidUpstreamResponse(
        "audit2026의 상세조회 응답이 올바른 JSON 형식이 아닙니다.",
        upstreamResponse,
        upstreamResult
      );
    }

    return jsonResponse(
      upstreamResult.data,
      upstreamResponse.status,
      {
        "X-Audit-Casebook-Proxy": "case-detail",
      }
    );
  } catch (error) {
    return connectionFailureResponse(
      "AUDIT_DETAIL_CONNECTION_FAILED",
      "audit2026 상세조회 호출 중 오류가 발생했습니다.",
      error
    );
  }
}

async function proxyAuditStatistics(env) {
  if (!hasAuditServiceBinding(env)) {
    return serviceBindingMissingResponse();
  }

  try {
    const upstreamResponse = await env.AUDIT_SERVICE.fetch(
      new Request("https://audit2026.internal/dashboard-data", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      })
    );

    const upstreamResult = await parseUpstreamJson(upstreamResponse);

    if (!upstreamResult.validJson) {
      return invalidUpstreamResponse(
        "audit2026의 통계 응답이 올바른 JSON 형식이 아닙니다.",
        upstreamResponse,
        upstreamResult
      );
    }

    if (!upstreamResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "AUDIT_STATISTICS_ERROR",
          message: "audit2026 통계 조회 중 오류가 발생했습니다.",
          upstreamStatus: upstreamResponse.status,
          auditService: upstreamResult.data,
        },
        502
      );
    }

    return jsonResponse(upstreamResult.data, 200, {
      "X-Audit-Casebook-Proxy": "dashboard-data",
    });
  } catch (error) {
    return connectionFailureResponse(
      "AUDIT_STATISTICS_CONNECTION_FAILED",
      "audit2026 통계 호출 중 오류가 발생했습니다.",
      error
    );
  }
}

function parseSearchLimit(limitValue) {
  if (limitValue === null || limitValue.trim() === "") {
    return {
      valid: true,
      value: DEFAULT_SEARCH_LIMIT,
    };
  }

  if (!/^\d+$/.test(limitValue.trim())) {
    return {
      valid: false,
      value: DEFAULT_SEARCH_LIMIT,
    };
  }

  const parsedLimit = Number(limitValue);

  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > MAX_SEARCH_LIMIT
  ) {
    return {
      valid: false,
      value: DEFAULT_SEARCH_LIMIT,
    };
  }

  return {
    valid: true,
    value: parsedLimit,
  };
}

function parseYearFilter(yearValue) {
  if (!yearValue) {
    return {
      valid: true,
      value: null,
    };
  }

  if (!/^\d{4}$/.test(yearValue)) {
    return {
      valid: false,
      value: null,
    };
  }

  const parsedYear = Number(yearValue);

  if (
    !Number.isInteger(parsedYear) ||
    parsedYear < 1900 ||
    parsedYear > 2200
  ) {
    return {
      valid: false,
      value: null,
    };
  }

  return {
    valid: true,
    value: parsedYear,
  };
}

function parseDispositionFilter(categoryValue, typeValue) {
  const category = String(categoryValue || "").trim();
  const type = String(typeValue || "")
    .replace(/[「」『』【】\[\]]/g, "")
    .trim();
  const allowedTypes = {
    administrative: [
      "주의",
      "시정",
      "개선",
      "통보",
      "권고",
      "경고",
      "기관경고",
      "현지조치",
    ],
    personnel: [
      "주의",
      "경고",
      "훈계",
      "문책",
      "징계",
      "견책",
      "감봉",
      "정직",
      "해임",
      "파면",
    ],
    financial: [
      "회수",
      "환수",
      "추징",
      "감액",
      "환급",
      "반납",
      "정산",
      "추급",
    ],
  };

  if (!category && !type) {
    return {
      valid: true,
      category: "",
      type: "",
      message: "",
    };
  }

  if (!Object.prototype.hasOwnProperty.call(
    allowedTypes,
    category
  )) {
    return {
      valid: false,
      category: "",
      type: "",
      message:
        "처분 구분을 행정상, 신분상 또는 재정상으로 선택해 주세요.",
    };
  }

  if (type && !allowedTypes[category].includes(type)) {
    return {
      valid: false,
      category,
      type: "",
      message:
        "선택한 처분 구분에서 지원하지 않는 처분 내용입니다.",
    };
  }

  return {
    valid: true,
    category,
    type,
    message: "",
  };
}

function hasAuditServiceBinding(env) {
  return (
    Boolean(env.AUDIT_SERVICE) &&
    typeof env.AUDIT_SERVICE.fetch === "function"
  );
}

function serviceBindingMissingResponse() {
  return jsonResponse(
    {
      success: false,
      error: "SERVICE_BINDING_NOT_FOUND",
      message: "AUDIT_SERVICE Service Binding이 설정되지 않았습니다.",
    },
    500
  );
}

function invalidUpstreamResponse(
  message,
  upstreamResponse,
  upstreamResult
) {
  return jsonResponse(
    {
      success: false,
      error: "INVALID_UPSTREAM_RESPONSE",
      message,
      upstreamStatus: upstreamResponse.status,
      upstreamPreview: upstreamResult.textPreview,
    },
    502
  );
}

function connectionFailureResponse(
  errorCode,
  message,
  error
) {
  return jsonResponse(
    {
      success: false,
      error: errorCode,
      message,
      detail:
        error instanceof Error
          ? error.message
          : String(error),
    },
    502
  );
}

async function parseUpstreamJson(response) {
  const responseText = await response.text();

  try {
    return {
      validJson: true,
      data: JSON.parse(responseText),
      textPreview: "",
    };
  } catch {
    return {
      validJson: false,
      data: null,
      textPreview: responseText.slice(0, 500),
    };
  }
}

function getHomePage() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <meta
    name="description"
    content="대구교통공사 종합감사 사례를 검색하고 열람하기 위한 디지털 사례집"
  >
  <title>${APP_NAME}</title>

  <style>
    :root {
      --navy-950: #0b2239;
      --navy-900: #102f4f;
      --navy-800: #164d73;
      --navy-700: #1d638f;
      --blue-100: #eaf4fb;
      --blue-200: #d3e8f5;
      --green-800: #12613f;
      --green-100: #e8f7ef;
      --amber-800: #8a4b08;
      --amber-100: #fff7e6;
      --red-700: #b42318;
      --red-100: #fef3f2;
      --gray-950: #17202a;
      --gray-900: #1f2933;
      --gray-700: #52606d;
      --gray-600: #616e7c;
      --gray-500: #7b8794;
      --gray-300: #cbd2d9;
      --gray-200: #e4e7eb;
      --gray-100: #f5f7fa;
      --white: #ffffff;
      --shadow: 0 14px 34px rgba(16, 42, 67, 0.09);
    }

    * {
      box-sizing: border-box;
    }

    html {
      font-size: 16px;
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--gray-900);
      background: var(--gray-100);
      font-family:
        "Pretendard",
        "Noto Sans KR",
        "Apple SD Gothic Neo",
        "Malgun Gothic",
        sans-serif;
      line-height: 1.65;
    }

    body.modal-open {
      overflow: hidden;
    }

    button,
    input {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.68;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    header {
      color: var(--white);
      background:
        linear-gradient(
          135deg,
          var(--navy-950),
          var(--navy-800)
        );
      border-bottom: 4px solid #2b7da8;
    }

    .header-inner,
    main {
      width: min(1120px, calc(100% - 40px));
      margin: 0 auto;
    }

    .header-inner {
      padding: 38px 0 36px;
    }

    .header-label {
      display: inline-block;
      margin-bottom: 8px;
      color: #c9e6f7;
      font-size: 0.875rem;
      font-weight: 700;
    }

    h1 {
      margin: 0;
      font-size: clamp(1.8rem, 4vw, 2.6rem);
      line-height: 1.25;
      letter-spacing: -0.04em;
    }

    .header-description {
      margin: 12px 0 0;
      color: #d9e8f2;
      font-size: 1.025rem;
    }

    .top-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;
    }

    .top-nav a {
      padding: 8px 13px;
      color: #e7f3fa;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 800;
      text-decoration: none;
    }

    .top-nav a:hover,
    .top-nav a[aria-current="page"] {
      color: var(--navy-950);
      background: var(--white);
      border-color: var(--white);
    }

    main {
      padding: 40px 0 64px;
    }

    .search-panel {
      padding: 30px;
      background: var(--white);
      border: 1px solid var(--gray-200);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }

    .search-panel h2 {
      margin: 0;
      color: var(--navy-900);
      font-size: 1.25rem;
    }

    .search-guide {
      margin: 7px 0 22px;
      color: var(--gray-700);
    }

    .search-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
    }

    .search-input,
    .filter-select {
      width: 100%;
      min-height: 54px;
      padding: 13px 16px;
      color: var(--gray-900);
      background: var(--white);
      border: 2px solid var(--gray-300);
      border-radius: 9px;
      outline: none;
    }

    .filter-select {
      cursor: pointer;
      font-weight: 700;
    }

    .search-input:focus,
    .filter-select:focus {
      border-color: var(--navy-700);
      box-shadow: 0 0 0 3px rgba(29, 99, 143, 0.15);
    }

    .filter-select:disabled {
      cursor: not-allowed;
      color: var(--gray-500);
      background: var(--gray-100);
    }

    .filter-row {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns:
        minmax(150px, 0.8fr)
        minmax(190px, 1fr)
        minmax(180px, 1fr)
        auto;
      gap: 10px;
      margin-top: 4px;
      padding-top: 16px;
      border-top: 1px solid var(--gray-200);
      align-items: end;
    }

    .filter-field {
      min-width: 0;
    }

    .filter-label {
      display: block;
      margin: 0 0 7px;
      color: var(--gray-700);
      font-size: 0.875rem;
      font-weight: 800;
    }

    .filter-select {
      min-height: 46px;
      padding: 10px 12px;
      border-width: 1px;
    }

    .filter-reset {
      min-height: 46px;
      padding: 10px 15px;
      color: var(--navy-800);
      background: var(--white);
      border: 1px solid var(--gray-300);
      border-radius: 8px;
      font-weight: 800;
      white-space: nowrap;
    }

    .filter-reset:hover:not(:disabled) {
      background: var(--gray-100);
      border-color: var(--navy-700);
    }

    .filter-reset:disabled {
      cursor: not-allowed;
      opacity: 0.65;
    }

    .search-button,
    .detail-button,
    .gpt-button {
      min-height: 42px;
      padding: 9px 17px;
      color: var(--white);
      background: var(--navy-800);
      border: 2px solid var(--navy-800);
      border-radius: 8px;
      font-weight: 700;
    }

    .search-button {
      min-width: 110px;
      min-height: 54px;
      padding: 12px 22px;
    }

    .search-button:hover:not(:disabled),
    .detail-button:hover,
    .gpt-button:hover:not(:disabled) {
      background: var(--navy-700);
      border-color: var(--navy-700);
    }

    .gpt-button {
      background: #3659a6;
      border-color: #3659a6;
      white-space: nowrap;
    }

    .gpt-button:hover:not(:disabled) {
      background: #284989;
      border-color: #284989;
    }

    .gpt-button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .gpt-action-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 17px;
      padding-top: 17px;
      border-top: 1px solid var(--gray-200);
    }

    .gpt-action-guide {
      color: var(--gray-600);
      font-size: 0.875rem;
    }

    .example-area {
      margin-top: 22px;
    }

    .example-label {
      display: block;
      margin-bottom: 9px;
      color: var(--gray-700);
      font-size: 0.925rem;
      font-weight: 700;
    }

    .example-list,
    .card-badges,
    .reason-list,
    .disposition-badges,
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .example-button {
      padding: 7px 12px;
      color: var(--navy-800);
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
      border-radius: 999px;
      font-size: 0.9rem;
    }

    .example-button:hover {
      background: var(--blue-200);
    }

    .loading-box,
    .error-box,
    .empty-box {
      margin-top: 24px;
      border-radius: 10px;
    }

    .loading-box {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 17px 19px;
      color: var(--navy-900);
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
      font-weight: 700;
    }

    .spinner {
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      border: 3px solid #a7d2e9;
      border-top-color: var(--navy-700);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error-box,
    .detail-error {
      padding: 17px 19px;
      color: var(--red-700);
      background: var(--red-100);
      border: 1px solid #fecdca;
      border-radius: 8px;
      font-weight: 700;
    }

    .empty-box {
      padding: 28px 20px;
      color: var(--gray-700);
      background: var(--white);
      border: 1px solid var(--gray-200);
      text-align: center;
    }

    .results-section {
      margin-top: 30px;
    }

    .results-header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }

    .results-title {
      margin: 0;
      color: var(--navy-900);
      font-size: 1.3rem;
    }

    .results-meta {
      margin: 0;
      color: var(--gray-600);
      font-size: 0.925rem;
    }

    .result-list {
      display: grid;
      gap: 16px;
    }

    .result-card {
      padding: 24px;
      background: var(--white);
      border: 1px solid var(--gray-200);
      border-left: 5px solid var(--navy-700);
      border-radius: 12px;
      box-shadow: 0 7px 20px rgba(16, 42, 67, 0.06);
    }

    .card-top,
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .year-badge,
    .similarity-badge,
    .reason-badge,
    .disposition-badge,
    .detail-meta-badge {
      display: inline-flex;
      align-items: center;
      min-height: 29px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 0.825rem;
      font-weight: 700;
    }

    .year-badge {
      color: var(--white);
      background: var(--navy-800);
    }

    .similarity-badge {
      color: var(--green-800);
      background: var(--green-100);
      border: 1px solid #b9e5cc;
    }

    .reason-badge,
    .detail-meta-badge {
      color: var(--navy-800);
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
    }

    .disposition-badge {
      color: var(--amber-800);
      background: var(--white);
      border: 1px solid #e6c98d;
    }

    .card-order {
      color: var(--gray-500);
      font-size: 0.825rem;
      font-weight: 700;
    }

    .card-title {
      margin: 11px 0 0;
      color: var(--navy-950);
      font-size: 1.25rem;
      line-height: 1.4;
    }

    .reason-area {
      margin-top: 13px;
    }

    .card-section {
      margin-top: 18px;
      padding-top: 17px;
      border-top: 1px solid var(--gray-200);
    }

    .card-section-title {
      margin: 0 0 7px;
      color: var(--gray-700);
      font-size: 0.9rem;
    }

    .preview-text,
    .disposition-text {
      margin: 0;
      white-space: pre-line;
      overflow-wrap: anywhere;
    }

    .disposition-area {
      margin-top: 18px;
      padding: 16px 17px;
      background: var(--amber-100);
      border: 1px solid #f0d9ad;
      border-radius: 9px;
    }

    .disposition-badges {
      margin-bottom: 9px;
    }

    .card-footer {
      align-items: flex-end;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px dashed var(--gray-300);
    }

    .card-actions {
      display: flex;
      flex: 0 0 auto;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .source-text {
      min-width: 0;
      color: var(--gray-600);
      font-size: 0.875rem;
      overflow-wrap: anywhere;
    }

    .source-label {
      color: var(--gray-700);
      font-weight: 800;
    }

    .system-note {
      margin-top: 20px;
      padding: 16px 18px;
      color: var(--gray-700);
      background: var(--white);
      border: 1px solid var(--gray-200);
      border-left: 4px solid var(--navy-700);
      border-radius: 8px;
      font-size: 0.925rem;
    }

    .detail-dialog {
      width: min(980px, calc(100% - 30px));
      max-height: 92vh;
      padding: 0;
      overflow: hidden;
      color: var(--gray-900);
      background: var(--white);
      border: 0;
      border-radius: 14px;
      box-shadow: 0 25px 70px rgba(0, 0, 0, 0.28);
    }

    .detail-dialog::backdrop {
      background: rgba(6, 24, 40, 0.67);
    }

    .detail-dialog-inner {
      display: flex;
      flex-direction: column;
      max-height: 92vh;
    }

    .detail-dialog-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      padding: 22px 24px;
      color: var(--white);
      background: var(--navy-900);
    }

    .detail-heading {
      margin: 0;
      font-size: 1.35rem;
      line-height: 1.4;
    }

    .detail-close {
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      color: var(--white);
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.45);
      border-radius: 8px;
      font-size: 1.5rem;
      line-height: 1;
    }

    .detail-close:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .detail-scroll {
      padding: 24px;
      overflow-y: auto;
    }

    .detail-meta {
      margin-bottom: 16px;
    }

    .detail-source,
    .detail-table-status {
      margin: 0 0 18px;
      padding: 12px 14px;
      color: var(--gray-700);
      background: var(--gray-100);
      border-radius: 8px;
      overflow-wrap: anywhere;
    }

    .detail-table-status {
      color: var(--green-800);
      background: var(--green-100);
      border: 1px solid #b9e5cc;
      font-weight: 700;
    }

    .detail-gpt-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 14px 0 18px;
      padding: 13px 14px;
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
      border-radius: 9px;
    }

    .detail-gpt-guide {
      color: var(--gray-700);
      font-size: 0.875rem;
    }

    .detail-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 180px;
      color: var(--navy-900);
      font-weight: 700;
    }

    .detail-section {
      margin-top: 18px;
      padding: 20px;
      border: 1px solid var(--gray-200);
      border-radius: 10px;
    }

    .detail-section:first-child {
      margin-top: 0;
    }

    .detail-section-heading {
      margin: 0 0 14px;
      padding-bottom: 9px;
      color: var(--navy-900);
      border-bottom: 2px solid var(--blue-200);
      font-size: 1.08rem;
    }

    .detail-paragraph {
      margin: 0 0 12px;
      line-height: 1.82;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .detail-paragraph:last-child {
      margin-bottom: 0;
    }

    .detail-document-box {
      margin: 17px 0;
      padding: 17px 19px;
      color: var(--gray-900);
      background: var(--gray-100);
      border-left: 4px solid var(--navy-700);
      border-radius: 8px;
    }

    .detail-document-paragraph {
      margin: 0 0 13px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: keep-all;
      overflow-wrap: break-word;
    }

    .detail-document-paragraph:last-child {
      margin-bottom: 0;
    }

    .table-container {
      margin: 17px 0;
      overflow-x: auto;
      border: 1px solid var(--gray-300);
      border-radius: 8px;
      background: var(--white);
      -webkit-overflow-scrolling: touch;
    }

    .detail-table {
      width: 100%;
      min-width: 620px;
      border-collapse: collapse;
      table-layout: auto;
      color: var(--gray-900);
      font-size: 0.925rem;
    }

    .detail-table caption {
      padding: 10px 12px;
      color: var(--navy-900);
      background: var(--blue-100);
      border-bottom: 1px solid var(--gray-300);
      font-weight: 800;
      text-align: left;
    }

    .detail-table th,
    .detail-table td {
      min-width: 104px;
      padding: 10px 12px;
      border-right: 1px solid var(--gray-300);
      border-bottom: 1px solid var(--gray-300);
      line-height: 1.55;
      text-align: left;
      vertical-align: middle;
      white-space: pre-wrap;
      word-break: keep-all;
      overflow-wrap: break-word;
    }

    .detail-table th {
      color: var(--navy-950);
      background: var(--blue-100);
      font-weight: 800;
      text-align: center;
      white-space: nowrap;
      word-break: keep-all;
      overflow-wrap: normal;
    }

    .detail-table .numeric-cell {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .detail-table tr:last-child th,
    .detail-table tr:last-child td {
      border-bottom: 0;
    }

    .detail-table th:last-child,
    .detail-table td:last-child {
      border-right: 0;
    }

    .detail-disposition {
      margin-top: 20px;
      padding: 20px;
      background: var(--amber-100);
      border: 1px solid #f0d9ad;
      border-radius: 10px;
    }

    .detail-disposition h3 {
      margin: 0 0 12px;
      color: var(--amber-800);
      font-size: 1.08rem;
    }

    .detail-disposition-summary {
      margin: 0;
      white-space: pre-wrap;
    }

    .disposition-group {
      margin-top: 15px;
    }

    .disposition-group h4 {
      margin: 0 0 7px;
      color: var(--amber-800);
      font-size: 0.95rem;
    }

    .disposition-list {
      margin: 0;
      padding-left: 21px;
    }

    .analysis-dialog { width: min(820px, calc(100% - 24px)); }
    .analysis-inner { height: min(780px, 90vh); height: min(780px, 90dvh); }
    .analysis-intro { margin: 0; padding: 14px 20px; color: var(--gray-700); background: var(--gray-100); font-size: 0.875rem; }
    .analysis-context { display: block; margin-top: 6px; font-weight: 700; overflow-wrap: anywhere; }
    .analysis-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 20px; }
    .analysis-message { margin-bottom: 16px; padding: 14px 16px; background: var(--gray-100); border-radius: 12px; overflow-wrap: anywhere; }
    .analysis-message.user { margin-left: 32px; background: var(--blue-100); }
    .analysis-message.assistant { margin-right: 16px; border: 1px solid var(--gray-200); }
    .analysis-message-label { display: block; margin-bottom: 8px; color: var(--navy-900); }
    .analysis-message-text { margin: 0; white-space: pre-wrap; line-height: 1.7; }
    .analysis-sources { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--gray-200); font-size: 0.85rem; }
    .analysis-sources ul { margin: 8px 0 0; padding-left: 20px; }
    .analysis-status { margin: 0; padding: 0 20px 12px; color: var(--gray-700); }
    .analysis-error { margin: 0 20px 12px; padding: 10px 12px; color: #8b2f2f; background: #fff1f1; border-radius: 8px; }
    .analysis-form { padding: 16px 20px; border-top: 1px solid var(--gray-200); }
    .analysis-form label { display: block; margin-bottom: 8px; font-weight: 700; }
    .analysis-input { width: 100%; min-height: 88px; max-height: 180px; resize: vertical; padding: 12px; border: 1px solid var(--gray-300); border-radius: 8px; font: inherit; }
    .analysis-actions { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; }
    .analysis-clear { padding: 10px 14px; color: var(--navy-900); background: var(--white); border: 1px solid var(--gray-300); border-radius: 8px; }

    [hidden] {
      display: none !important;
    }

    footer {
      padding: 24px 20px;
      color: var(--gray-500);
      text-align: center;
      font-size: 0.875rem;
    }

    @media (max-width: 640px) {
      .header-inner,
      main {
        width: min(100% - 28px, 1120px);
      }

      .header-inner {
        padding: 30px 0 28px;
      }

      main {
        padding: 24px 0 48px;
      }

      .search-panel {
        padding: 20px;
      }

      .search-form {
        grid-template-columns: 1fr;
      }

      .filter-row {
        grid-column: auto;
        grid-template-columns: 1fr;
      }

      .search-button,
      .detail-button,
      .gpt-button,
      .filter-reset {
        width: 100%;
      }

      .gpt-action-row,
      .detail-gpt-row {
        align-items: stretch;
        flex-direction: column;
      }

      .results-header,
      .card-top,
      .card-footer {
        align-items: flex-start;
        flex-direction: column;
      }

      .card-actions {
        width: 100%;
        flex-direction: column;
      }

      .result-card {
        padding: 19px;
      }

      .detail-dialog {
        width: calc(100% - 16px);
        max-height: 96vh;
      }

      .detail-dialog-inner {
        max-height: 96vh;
      }

      .detail-dialog-header,
      .detail-scroll {
        padding: 18px;
      }

      .detail-heading {
        font-size: 1.12rem;
      }

      .detail-section {
        padding: 15px;
      }

      .detail-table {
        min-width: 560px;
        font-size: 0.86rem;
      }

      .detail-table th,
      .detail-table td {
        padding: 9px 10px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="header-inner">
      <span class="header-label">
        대구교통공사 내부 업무용
      </span>
      <h1>${APP_NAME}</h1>
      <p class="header-description">
        감사사례를 키워드와 의미 유사검색으로 조회합니다.
      </p>
      <nav class="top-nav" aria-label="주요 메뉴">
        <a href="/" aria-current="page">사례 검색</a>
        <a href="/statistics">통계 현황</a>
      </nav>
    </div>
  </header>

  <main>
    <section
      class="search-panel"
      aria-labelledby="searchTitle"
    >
      <h2 id="searchTitle">감사사례 검색</h2>
      <p class="search-guide">
        사례 제목, 업무 내용, 문제점 또는 처분과 관련된
        검색어를 입력해 주세요.
      </p>

      <form
        id="searchForm"
        class="search-form"
        role="search"
      >
        <label
          for="searchInput"
          class="visually-hidden"
        >
          감사사례 검색어
        </label>

        <input
          id="searchInput"
          class="search-input"
          type="search"
          maxlength="${MAX_QUERY_LENGTH}"
          autocomplete="off"
          required
          placeholder="예: 공사 설계 노무비 중복 적용"
        >

        <button
          id="searchButton"
          class="search-button"
          type="submit"
        >
          검색
        </button>

        <div
          class="filter-row"
          aria-label="감사사례 검색 필터"
        >
          <div class="filter-field">
            <label
              for="yearFilter"
              class="filter-label"
            >
              연도
            </label>
            <select
              id="yearFilter"
              class="filter-select"
            >
              <option value="">전체 연도</option>
            </select>
          </div>

          <div class="filter-field">
            <label
              for="dispositionCategory"
              class="filter-label"
            >
              처분 구분
            </label>
            <select
              id="dispositionCategory"
              class="filter-select"
            >
              <option value="">전체 처분</option>
              <option value="administrative">
                행정상 처분(부서)
              </option>
              <option value="personnel">
                신분상 처분(직원)
              </option>
              <option value="financial">
                재정상 처분
              </option>
            </select>
          </div>

          <div class="filter-field">
            <label
              for="dispositionType"
              class="filter-label"
            >
              처분 내용
            </label>
            <select
              id="dispositionType"
              class="filter-select"
              disabled
            >
              <option value="">
                처분 구분을 먼저 선택
              </option>
            </select>
          </div>

          <button
            id="filterResetButton"
            class="filter-reset"
            type="button"
          >
            필터 초기화
          </button>
        </div>
      </form>

      <div class="gpt-action-row">
        <button
          id="searchGptButton"
          class="gpt-button"
          type="button"
        >
          AI 분석 · 질문하기
        </button>
        <span class="gpt-action-guide">
          분석 팝업에서 감사사례를 질문하고 답변을 확인합니다.
        </span>
      </div>

      <div class="example-area">
        <span class="example-label">검색 예시</span>
        <div class="example-list">
          <button class="example-button" type="button"
            data-query="공사 설계 노무비 중복 적용">
            공사 설계 노무비 중복 적용
          </button>
          <button class="example-button" type="button"
            data-query="산업안전보건관리비 정산">
            산업안전보건관리비 정산
          </button>
          <button class="example-button" type="button"
            data-query="계측기기 관리 소홀">
            계측기기 관리 소홀
          </button>
          <button class="example-button" type="button"
            data-query="예산 목적 외 사용">
            예산 목적 외 사용
          </button>
          <button class="example-button" type="button"
            data-query="근태관리 소홀">
            근태관리 소홀
          </button>
          <button class="example-button" type="button"
            data-query="계약 및 정산업무">
            계약 및 정산업무
          </button>
          <button class="example-button" type="button"
            data-query="물품관리 부적정">
            물품관리 부적정
          </button>
        </div>
      </div>

      <div
        id="loadingBox"
        class="loading-box"
        role="status"
        aria-live="polite"
        hidden
      >
        <span class="spinner" aria-hidden="true"></span>
        <span>감사사례를 검색하고 있습니다.</span>
      </div>

      <div
        id="errorBox"
        class="error-box"
        role="alert"
        hidden
      ></div>
    </section>

    <section
      id="resultsSection"
      class="results-section"
      aria-labelledby="resultsTitle"
      hidden
    >
      <div class="results-header">
        <h2 id="resultsTitle" class="results-title">
          검색 결과
        </h2>
        <p
          id="resultsMeta"
          class="results-meta"
          aria-live="polite"
        ></p>
      </div>

      <div id="emptyBox" class="empty-box" hidden>
        조건에 맞는 감사사례를 찾지 못했습니다.
      </div>

      <div id="resultList" class="result-list"></div>
    </section>

    <div class="system-note">
      관련도는 audit2026의 키워드 일치와 의미 유사검색 결과를
      함께 반영합니다. 분석 팝업에서는 감사사례를 바탕으로 AI 답변을
      제공합니다. 답변의 근거와 원문을 함께 확인해 주세요.
    </div>
  </main>

  <footer>
    종합감사 디지털 사례집 · 내부 업무 지원 시스템
  </footer>

  <dialog
    id="detailDialog"
    class="detail-dialog"
    aria-labelledby="detailHeading"
  >
    <div class="detail-dialog-inner">
      <div class="detail-dialog-header">
        <h2 id="detailHeading" class="detail-heading">
          사례 상세보기
        </h2>
        <button
          id="detailCloseButton"
          class="detail-close"
          type="button"
          aria-label="상세보기 닫기"
        >
          ×
        </button>
      </div>

      <div class="detail-scroll">
        <div
          id="detailLoading"
          class="detail-loading"
          hidden
        >
          <span class="spinner" aria-hidden="true"></span>
          <span>원본 DOCX에서 전체 사례를 불러오고 있습니다.</span>
        </div>

        <div
          id="detailError"
          class="detail-error"
          role="alert"
          hidden
        ></div>

        <div id="detailContent" hidden>
          <div id="detailMeta" class="detail-meta"></div>
          <p id="detailSource" class="detail-source"></p>
          <div class="detail-gpt-row">
            <button
              id="detailGptButton"
              class="gpt-button"
              type="button"
              disabled
            >
              이 사례 분석 · 질문하기
            </button>
            <span class="detail-gpt-guide">
              전체 사례 내용을 바탕으로 팝업에서 질문합니다.
            </span>
          </div>
          <p
            id="detailTableStatus"
            class="detail-table-status"
            hidden
          ></p>
          <div id="detailSections"></div>
          <div id="detailDisposition"></div>
        </div>
      </div>
    </div>
  </dialog>

  <dialog id="analysisDialog" class="detail-dialog analysis-dialog" aria-labelledby="analysisHeading">
    <div class="detail-dialog-inner analysis-inner">
      <div class="detail-dialog-header">
        <h2 id="analysisHeading" class="detail-heading">감사사례 AI 분석</h2>
        <button id="analysisClose" class="detail-close" type="button" aria-label="분석 팝업 닫기">×</button>
      </div>
      <p class="analysis-intro">
        감사사례를 참고해 AI가 답변합니다. 후속 질문을 이어서 할 수 있습니다.
        <span id="analysisContext" class="analysis-context"></span>
      </p>
      <div id="analysisMessages" class="analysis-messages" role="log" aria-label="질문과 답변" aria-live="polite"></div>
      <p id="analysisStatus" class="analysis-status" role="status" hidden>관련 사례를 찾아 답변을 작성하고 있습니다…</p>
      <p id="analysisError" class="analysis-error" role="alert" hidden></p>
      <form id="analysisForm" class="analysis-form">
        <label for="analysisInput">질문</label>
        <textarea id="analysisInput" class="analysis-input" maxlength="${MAX_ASK_LENGTH}" required placeholder="궁금한 점을 입력해 주세요. 예: 이 사례의 주요 문제점과 개선방안은 무엇인가요?"></textarea>
        <div class="analysis-actions">
          <button id="analysisClear" class="analysis-clear" type="button">새 대화</button>
          <button id="analysisSend" class="gpt-button" type="submit">질문 보내기</button>
        </div>
      </form>
    </div>
  </dialog>

  <script>
    (function () {
      var searchForm =
        document.getElementById("searchForm");
      var searchInput =
        document.getElementById("searchInput");
      var searchButton =
        document.getElementById("searchButton");
      var yearFilter =
        document.getElementById("yearFilter");
      var dispositionCategory =
        document.getElementById(
          "dispositionCategory"
        );
      var dispositionType =
        document.getElementById(
          "dispositionType"
        );
      var filterResetButton =
        document.getElementById(
          "filterResetButton"
        );
      var loadingBox =
        document.getElementById("loadingBox");
      var errorBox =
        document.getElementById("errorBox");
      var resultsSection =
        document.getElementById("resultsSection");
      var resultsMeta =
        document.getElementById("resultsMeta");
      var emptyBox =
        document.getElementById("emptyBox");
      var resultList =
        document.getElementById("resultList");
      var exampleButtons =
        document.querySelectorAll(".example-button");
      var searchGptButton =
        document.getElementById("searchGptButton");
      var analysisDialog = document.getElementById("analysisDialog");
      var analysisMessages = document.getElementById("analysisMessages");
      var analysisInput = document.getElementById("analysisInput");
      var analysisSend = document.getElementById("analysisSend");
      var analysisStatus = document.getElementById("analysisStatus");
      var analysisError = document.getElementById("analysisError");
      var analysisContextText = "";
      var analysisHistory = [];
      var activeAnalysisController = null;
      var lastAnalysisTrigger = null;

      var detailDialog =
        document.getElementById("detailDialog");
      var detailHeading =
        document.getElementById("detailHeading");
      var detailCloseButton =
        document.getElementById("detailCloseButton");
      var detailLoading =
        document.getElementById("detailLoading");
      var detailError =
        document.getElementById("detailError");
      var detailContent =
        document.getElementById("detailContent");
      var detailMeta =
        document.getElementById("detailMeta");
      var detailSource =
        document.getElementById("detailSource");
      var detailTableStatus =
        document.getElementById("detailTableStatus");
      var detailSections =
        document.getElementById("detailSections");
      var detailDisposition =
        document.getElementById("detailDisposition");
      var detailGptButton =
        document.getElementById("detailGptButton");

      var activeSearchController = null;
      var activeDetailController = null;
      var lastDetailTrigger = null;
      var currentDetailData = null;
      var dispositionOptions = {
        administrative: {
          allLabel: "행정상 처분 전체",
          items: [
            "주의",
            "시정",
            "개선",
            "통보",
            "권고",
            "경고",
            "기관경고",
            "현지조치"
          ]
        },
        personnel: {
          allLabel: "신분상 처분 전체",
          items: [
            "주의",
            "경고",
            "훈계",
            "문책",
            "징계",
            "견책",
            "감봉",
            "정직",
            "해임",
            "파면"
          ]
        },
        financial: {
          allLabel: "재정상 처분 전체",
          items: [
            "회수",
            "환수",
            "추징",
            "감액",
            "환급",
            "반납",
            "정산",
            "추급"
          ]
        }
      };

      updateDispositionTypeOptions();
      loadYearOptions();

      searchForm.addEventListener(
        "submit",
        function (event) {
          event.preventDefault();
          runSearch(searchInput.value);
        }
      );

      exampleButtons.forEach(function (button) {
        button.addEventListener("click", function () {
          var query =
            button.getAttribute("data-query") || "";

          searchInput.value = query;
          runSearch(query);
        });
      });

      searchGptButton.addEventListener(
        "click",
        function () {
          openAnalysisChat(
            buildSearchGptText(
              String(searchInput.value || "").trim()
            ),
            "검색 주제: " + (String(searchInput.value || "").trim() || "감사사례"),
            searchGptButton
          );
        }
      );

      yearFilter.addEventListener(
        "change",
        function () {
          var query = String(searchInput.value || "").trim();

          if (query) {
            runSearch(query);
          }
        }
      );

      dispositionCategory.addEventListener(
        "change",
        function () {
          updateDispositionTypeOptions();
          rerunCurrentSearch();
        }
      );

      dispositionType.addEventListener(
        "change",
        function () {
          rerunCurrentSearch();
        }
      );

      filterResetButton.addEventListener(
        "click",
        function () {
          yearFilter.value = "";
          dispositionCategory.value = "";
          updateDispositionTypeOptions();
          rerunCurrentSearch();
        }
      );

      detailCloseButton.addEventListener(
        "click",
        function () {
          detailDialog.close();
        }
      );

      detailGptButton.addEventListener(
        "click",
        function () {
          if (!currentDetailData) {
            return;
          }

          openAnalysisChat(
            buildDetailGptText(currentDetailData),
            "선택한 사례: " + safeText(currentDetailData.title, "제목 없음"),
            detailGptButton
          );
        }
      );

      detailDialog.addEventListener(
        "close",
        function () {
          if (!analysisDialog.open) document.body.classList.remove("modal-open");

          if (activeDetailController) {
            activeDetailController.abort();
            activeDetailController = null;
          }

          if (lastDetailTrigger) {
            lastDetailTrigger.focus();
          }
        }
      );

      detailDialog.addEventListener(
        "click",
        function (event) {
          if (event.target === detailDialog) {
            detailDialog.close();
          }
        }
      );

      async function runSearch(queryValue) {
        var query = String(queryValue || "").trim();
        var selectedYear =
          String(yearFilter.value || "").trim();
        var selectedDispositionCategory =
          String(
            dispositionCategory.value || ""
          ).trim();
        var selectedDispositionType =
          String(
            dispositionType.value || ""
          ).trim();

        if (!query) {
          showSearchError("검색어를 입력해 주세요.");
          searchInput.focus();
          return;
        }

        if (activeSearchController) {
          activeSearchController.abort();
        }

        var currentController = new AbortController();
        activeSearchController = currentController;

        clearSearchResults();
        setSearchLoading(true);

        try {
          var params = new URLSearchParams();
          params.set("q", query);
          params.set(
            "limit",
            String(${DEFAULT_SEARCH_LIMIT})
          );

          if (selectedYear) {
            params.set("year", selectedYear);
          }

          if (selectedDispositionCategory) {
            params.set(
              "dispositionCategory",
              selectedDispositionCategory
            );
          }

          if (selectedDispositionType) {
            params.set(
              "dispositionType",
              selectedDispositionType
            );
          }

          var response = await fetch(
            "/api/search?" + params.toString(),
            {
              headers: {
                Accept: "application/json"
              },
              signal: currentController.signal
            }
          );

          var data = await readJsonResponse(response);

          if (!response.ok || data.success === false) {
            throw new Error(
              data.message ||
              data.error ||
              "검색 중 오류가 발생했습니다."
            );
          }

          renderResults(
            data,
            query,
            selectedYear,
            selectedDispositionCategory,
            selectedDispositionType
          );
        } catch (error) {
          if (error.name !== "AbortError") {
            showSearchError(
              error instanceof Error
                ? error.message
                : "검색 중 오류가 발생했습니다."
            );
          }
        } finally {
          if (activeSearchController === currentController) {
            activeSearchController = null;
            setSearchLoading(false);
          }
        }
      }

      function rerunCurrentSearch() {
        var query = String(searchInput.value || "").trim();

        if (query) {
          runSearch(query);
        }
      }

      function updateDispositionTypeOptions() {
        var category =
          String(dispositionCategory.value || "").trim();
        var configuration =
          dispositionOptions[category];

        dispositionType.textContent = "";

        if (!configuration) {
          dispositionType.appendChild(
            createSelectOption(
              "",
              "처분 구분을 먼저 선택"
            )
          );
          dispositionType.disabled = true;
          return;
        }

        dispositionType.appendChild(
          createSelectOption(
            "",
            configuration.allLabel
          )
        );

        configuration.items.forEach(function (item) {
          dispositionType.appendChild(
            createSelectOption(item, item)
          );
        });

        dispositionType.disabled = false;
      }

      async function loadYearOptions() {
        yearFilter.disabled = true;

        try {
          var response = await fetch("/api/years", {
            headers: {
              Accept: "application/json"
            }
          });
          var data = await readJsonResponse(response);

          if (!response.ok || data.success === false) {
            throw new Error(
              data.message ||
              "연도 목록을 불러오지 못했습니다."
            );
          }

          var years = Array.isArray(data.years)
            ? data.years
            : [];
          var currentValue = yearFilter.value;

          yearFilter.textContent = "";
          yearFilter.appendChild(
            createYearOption("", "전체 연도")
          );

          years.forEach(function (item) {
            var year = String(item.year || "").trim();
            var count = Number(item.count || 0);

            if (!year) {
              return;
            }

            yearFilter.appendChild(
              createYearOption(
                year,
                year + "년 (" + count + "건)"
              )
            );
          });

          yearFilter.value = currentValue;
        } catch (error) {
          yearFilter.textContent = "";
          yearFilter.appendChild(
            createYearOption("", "전체 연도")
          );
        } finally {
          yearFilter.disabled = false;
        }
      }

      function createYearOption(value, label) {
        return createSelectOption(value, label);
      }

      function createSelectOption(value, label) {
        var option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }

      function renderResults(
        data,
        query,
        selectedYear,
        selectedDispositionCategory,
        selectedDispositionType
      ) {
        var results = Array.isArray(data.results)
          ? data.results
          : [];

        resultList.textContent = "";

        var metaText =
          "‘" + query + "’";

        if (selectedYear) {
          metaText += " · " + selectedYear + "년";
        } else {
          metaText += " · 전체 연도";
        }

        var dispositionLabel =
          getDispositionFilterLabel(
            selectedDispositionCategory,
            selectedDispositionType
          );

        if (dispositionLabel) {
          metaText += " · " + dispositionLabel;
        }

        metaText +=
          " 검색 결과 " +
          results.length + "건";

        if (typeof data.elapsedMs === "number") {
          metaText +=
            " · " +
            (data.elapsedMs / 1000).toFixed(2) +
            "초";
        }

        resultsMeta.textContent = metaText;
        resultsSection.hidden = false;
        emptyBox.hidden = results.length !== 0;

        results.forEach(function (item, index) {
          resultList.appendChild(
            createResultCard(item, index)
          );
        });
      }

      function getDispositionFilterLabel(
        category,
        type
      ) {
        var categoryLabels = {
          administrative: "행정상 처분(부서)",
          personnel: "신분상 처분(직원)",
          financial: "재정상 처분"
        };
        var label = categoryLabels[category] || "";

        if (!label) {
          return "";
        }

        return type
          ? label + " · " + type
          : label + " 전체";
      }

      function createResultCard(item, index) {
        var card = makeElement("article", "result-card");
        var cardTop = makeElement("div", "card-top");
        var cardBadges = makeElement("div", "card-badges");

        cardBadges.appendChild(
          makeElement(
            "span",
            "year-badge",
            formatYear(item.year)
          )
        );

        if (
          typeof item.vectorScore === "number" &&
          Number.isFinite(item.vectorScore)
        ) {
          var similarity =
            Math.max(
              0,
              Math.min(100, item.vectorScore * 100)
            ).toFixed(1);

          cardBadges.appendChild(
            makeElement(
              "span",
              "similarity-badge",
              "의미 유사도 " + similarity + "%"
            )
          );
        }

        cardTop.appendChild(cardBadges);
        cardTop.appendChild(
          makeElement(
            "span",
            "card-order",
            "검색결과 " + (index + 1)
          )
        );
        card.appendChild(cardTop);

        card.appendChild(
          makeElement(
            "h3",
            "card-title",
            safeText(item.title, "제목 없음")
          )
        );

        var reasons = Array.isArray(item.matchReasons)
          ? item.matchReasons
          : [];

        if (reasons.length > 0) {
          var reasonArea =
            makeElement("div", "reason-area");
          var reasonList =
            makeElement("div", "reason-list");

          reasons.slice(0, 6).forEach(function (reason) {
            reasonList.appendChild(
              makeElement(
                "span",
                "reason-badge",
                safeText(reason, "일치")
              )
            );
          });

          reasonArea.appendChild(reasonList);
          card.appendChild(reasonArea);
        }

        var previewSection =
          makeElement("section", "card-section");

        previewSection.appendChild(
          makeElement(
            "h4",
            "card-section-title",
            "문제점 미리보기"
          )
        );

        previewSection.appendChild(
          makeElement(
            "p",
            "preview-text",
            truncateText(
              safeText(
                item.preview,
                "미리보기 내용이 없습니다."
              ),
              520
            )
          )
        );
        card.appendChild(previewSection);

        var dispositionArea =
          makeElement("section", "disposition-area");

        dispositionArea.appendChild(
          makeElement(
            "h4",
            "card-section-title",
            "처분사항"
          )
        );

        appendDispositionBadges(
          dispositionArea,
          item.dispositionParsed
        );

        dispositionArea.appendChild(
          makeElement(
            "p",
            "disposition-text",
            truncateText(
              getDispositionText(item),
              500
            )
          )
        );
        card.appendChild(dispositionArea);

        var cardFooter =
          makeElement("div", "card-footer");
        var sourceText =
          makeElement("div", "source-text");

        sourceText.appendChild(
          makeElement(
            "span",
            "source-label",
            "출처 파일: "
          )
        );
        sourceText.appendChild(
          document.createTextNode(
            safeText(
              item.sourceFile,
              "파일명 정보 없음"
            )
          )
        );

        var detailButton =
          makeElement(
            "button",
            "detail-button",
            "상세보기"
          );
        detailButton.type = "button";
        detailButton.addEventListener(
          "click",
          function () {
            openDetail(item, detailButton);
          }
        );

        var gptButton =
          makeElement(
            "button",
            "gpt-button",
            "AI 분석 · 질문하기"
          );
        gptButton.type = "button";
        gptButton.addEventListener(
          "click",
          function () {
            openAnalysisChat(
              buildCardGptText(item),
              "선택한 사례: " + safeText(item.title, "제목 없음"),
              gptButton
            );
          }
        );

        var cardActions =
          makeElement("div", "card-actions");
        cardActions.appendChild(detailButton);
        cardActions.appendChild(gptButton);

        cardFooter.appendChild(sourceText);
        cardFooter.appendChild(cardActions);
        card.appendChild(cardFooter);

        return card;
      }

      async function openDetail(item, triggerButton) {
        lastDetailTrigger = triggerButton;

        if (activeDetailController) {
          activeDetailController.abort();
        }

        var currentController = new AbortController();
        activeDetailController = currentController;

        resetDetail();
        detailHeading.textContent =
          safeText(item.title, "사례 상세보기");
        detailLoading.hidden = false;

        if (!detailDialog.open) {
          detailDialog.showModal();
          document.body.classList.add("modal-open");
        }

        try {
          var params = new URLSearchParams();
          params.set("id", String(item.id));

          var response = await fetch(
            "/api/detail?" + params.toString(),
            {
              headers: {
                Accept: "application/json"
              },
              signal: currentController.signal
            }
          );

          var data = await readJsonResponse(response);

          if (!response.ok || data.success === false) {
            throw new Error(
              data.message ||
              data.error ||
              "사례 전체 내용을 불러오지 못했습니다."
            );
          }

          renderDetail(data);
        } catch (error) {
          if (error.name !== "AbortError") {
            detailError.textContent =
              error instanceof Error
                ? error.message
                : "상세조회 중 오류가 발생했습니다.";
            detailError.hidden = false;
          }
        } finally {
          if (activeDetailController === currentController) {
            activeDetailController = null;
            detailLoading.hidden = true;
          }
        }
      }

      function renderDetail(caseData) {
        currentDetailData = caseData;
        detailGptButton.disabled = false;
        detailHeading.textContent =
          safeText(caseData.title, "사례 상세보기");

        detailMeta.appendChild(
          makeElement(
            "span",
            "detail-meta-badge",
            formatYear(caseData.year)
          )
        );

        detailMeta.appendChild(
          makeElement(
            "span",
            "detail-meta-badge",
            "사례 ID " +
            safeText(caseData.id, "정보 없음")
          )
        );

        detailSource.textContent =
          "출처 파일: " +
          safeText(
            caseData.sourceFile,
            "파일명 정보 없음"
          );

        if (
          caseData.tableStructureAvailable === true
        ) {
          detailTableStatus.textContent =
            "원본 DOCX 표 구조 확인 · 표 " +
            Number(caseData.tableCount || 0) +
            "개";
          detailTableStatus.hidden = false;
        }

        if (caseData.warning) {
          detailError.textContent = String(caseData.warning);
          detailError.hidden = false;
        }

        var sections = Array.isArray(caseData.sections)
          ? caseData.sections
          : [];

        if (sections.length === 0) {
          detailSections.appendChild(
            makeElement(
              "div",
              "detail-error",
              "표시할 전체 섹션이 없습니다."
            )
          );
        } else {
          sections.forEach(function (section) {
            detailSections.appendChild(
              createDetailSection(section)
            );
          });
        }

        renderDetailDisposition(caseData);
        detailContent.hidden = false;
      }

      function createDetailSection(section) {
        var sectionElement =
          makeElement("section", "detail-section");

        sectionElement.appendChild(
          makeElement(
            "h3",
            "detail-section-heading",
            safeText(section.heading, "본문")
          )
        );

        var blocks = Array.isArray(section.blocks)
          ? section.blocks
          : [];

        for (
          var blockIndex = 0;
          blockIndex < blocks.length;
          blockIndex += 1
        ) {
          var block = blocks[blockIndex];

          if (block && block.type === "table") {
            var normalizedTable =
              normalizeStructuredTable(block);

            while (
              blockIndex + 1 < blocks.length &&
              blocks[blockIndex + 1] &&
              blocks[blockIndex + 1].type === "table"
            ) {
              var nextTable = normalizeStructuredTable(
                blocks[blockIndex + 1]
              );

              if (
                !canMergeContinuationTables(
                  normalizedTable,
                  nextTable
                )
              ) {
                break;
              }

              normalizedTable.rows =
                normalizedTable.rows.concat(
                  nextTable.rows
                );
              blockIndex += 1;
            }

            sectionElement.appendChild(
              createStructuredTable(normalizedTable)
            );
            continue;
          }

          if (block && block.type === "paragraph") {
            sectionElement.appendChild(
              makeElement(
                "p",
                "detail-paragraph",
                safeText(block.text, "")
              )
            );
          }
        }

        return sectionElement;
      }

      function createStructuredTable(tableData) {
        if (shouldRenderAsDocumentBox(tableData)) {
          return createDocumentBox(tableData);
        }

        var container =
          makeElement("div", "table-container");
        var table =
          makeElement("table", "detail-table");

        if (
          typeof tableData.caption === "string" &&
          tableData.caption.trim()
        ) {
          table.appendChild(
            makeElement(
              "caption",
              "",
              tableData.caption.trim()
            )
          );
        }

        var thead = document.createElement("thead");
        var tbody = document.createElement("tbody");
        var hasHeadRows = false;
        var rows = Array.isArray(tableData.rows)
          ? tableData.rows
          : [];

        rows.forEach(function (row, rowIndex) {
          var tr = document.createElement("tr");
          var cells = Array.isArray(row.cells)
            ? row.cells
            : [];
          var isHeaderRow = isLikelyHeaderRow(row);

          cells.forEach(function (cell) {
            var isHeader =
              Boolean(cell.header) ||
              Boolean(row.header) ||
              isHeaderRow;

            var cellElement = document.createElement(
              isHeader ? "th" : "td"
            );

            cellElement.textContent =
              safeText(cell.text, "");

            var rowSpan =
              normalizeSpanValue(cell.rowSpan);
            var colSpan =
              normalizeSpanValue(cell.colSpan);

            if (rowSpan > 1) {
              cellElement.rowSpan = rowSpan;
            }

            if (colSpan > 1) {
              cellElement.colSpan = colSpan;
            }

            if (isHeader) {
              cellElement.scope = "col";
            } else if (looksNumericCell(cell.text)) {
              cellElement.classList.add("numeric-cell");
            }

            tr.appendChild(cellElement);
          });

          if (isHeaderRow) {
            thead.appendChild(tr);
            hasHeadRows = true;
          } else {
            tbody.appendChild(tr);
          }
        });

        if (hasHeadRows) {
          table.appendChild(thead);
        }

        table.appendChild(tbody);
        container.appendChild(table);
        return container;
      }

      function shouldRenderAsDocumentBox(tableData) {
        var caption = safeText(
          tableData && tableData.caption,
          ""
        )
          .replace(/\\s+/g, "")
          .trim();

        return (
          Number(tableData && tableData.columnCount) === 1 &&
          caption === "《관련근거》"
        );
      }

      function createDocumentBox(tableData) {
        var box =
          makeElement("div", "detail-document-box");
        var rows = Array.isArray(tableData.rows)
          ? tableData.rows
          : [];

        rows.forEach(function (row) {
          var texts = getNonEmptyCellTexts(row);

          texts.forEach(function (text) {
            box.appendChild(
              makeElement(
                "p",
                "detail-document-paragraph",
                text
              )
            );
          });
        });

        return box;
      }

      function normalizeStructuredTable(tableData) {
        var sourceRows = Array.isArray(tableData.rows)
          ? tableData.rows
          : [];
        var rows = sourceRows.map(function (row) {
          return {
            header: Boolean(row && row.header),
            index: row && row.index,
            cells: Array.isArray(row && row.cells)
              ? row.cells.map(function (cell) {
                  return {
                    text: safeText(cell && cell.text, ""),
                    header: Boolean(cell && cell.header),
                    rowSpan: normalizeSpanValue(
                      cell && cell.rowSpan
                    ),
                    colSpan: normalizeSpanValue(
                      cell && cell.colSpan
                    ),
                  };
                })
              : [],
          };
        });

        var caption =
          typeof tableData.caption === "string"
            ? tableData.caption.trim()
            : "";

        var titleResult =
          removeDecorativeTableTitleRows(rows);

        rows = titleResult.rows.filter(function (row) {
          return !isCompletelyEmptyRow(row);
        });

        if (!caption && titleResult.title) {
          caption = titleResult.title;
        }

        var columnCount =
          determineLogicalColumnCount(rows);

        rows.forEach(function (row) {
          var cells = Array.isArray(row.cells)
            ? row.cells
            : [];
          var spanTotal = cells.reduce(
            function (total, cell) {
              return total +
                normalizeSpanValue(cell.colSpan);
            },
            0
          );

          /*
           * Word 표에서 행마다 서로 다른 열 격자를 사용하면
           * Mammoth가 정상 머리글의 첫 셀에 잘못된 colspan을
           * 붙이는 경우가 있다. 셀 개수가 이미 논리 열 수와
           * 같으면 각 셀은 한 열로 보정한다.
           */
          if (
            columnCount > 1 &&
            cells.length === columnCount &&
            spanTotal > columnCount
          ) {
            cells.forEach(function (cell) {
              cell.colSpan = 1;
            });
          }
        });

        return {
          type: "table",
          caption: caption,
          rows: rows,
          columnCount: columnCount,
          hasHeader: rows.some(isLikelyHeaderRow),
        };
      }

      function removeDecorativeTableTitleRows(rows) {
        var remaining = rows.slice();
        var title = "";

        if (remaining.length === 0) {
          return {
            title: title,
            rows: remaining,
          };
        }

        var firstNonEmpty = getNonEmptyCellTexts(
          remaining[0]
        );

        if (
          firstNonEmpty.length === 1 &&
          /^《[\\s\\S]+》$/.test(firstNonEmpty[0])
        ) {
          title = firstNonEmpty[0];
          remaining.shift();

          if (
            remaining.length > 0 &&
            isCompletelyEmptyRow(remaining[0])
          ) {
            remaining.shift();
          }
        }

        return {
          title: title,
          rows: remaining,
        };
      }

      function getNonEmptyCellTexts(row) {
        var cells = Array.isArray(row && row.cells)
          ? row.cells
          : [];

        return cells
          .map(function (cell) {
            return safeText(cell && cell.text, "").trim();
          })
          .filter(function (text) {
            return Boolean(text);
          });
      }

      function isCompletelyEmptyRow(row) {
        return getNonEmptyCellTexts(row).length === 0;
      }

      function determineLogicalColumnCount(rows) {
        return rows.reduce(function (maximum, row) {
          var count = Array.isArray(row && row.cells)
            ? row.cells.length
            : 0;
          return Math.max(maximum, count);
        }, 0);
      }

      function isLikelyHeaderRow(row) {
        if (!row) {
          return false;
        }

        if (
          Boolean(row.header) ||
          (
            Array.isArray(row.cells) &&
            row.cells.some(function (cell) {
              return Boolean(cell && cell.header);
            })
          )
        ) {
          return true;
        }

        var headerWords = [
          "연번",
          "번호",
          "부서",
          "소속",
          "항목",
          "품목",
          "품명",
          "규격",
          "수량",
          "구매일자",
          "구매금액",
          "구매예산",
          "실구매금액",
          "초과금액",
          "구분",
          "내용",
          "금액",
          "비고",
        ];

        var normalizedTexts = getNonEmptyCellTexts(row)
          .map(function (text) {
            return text.replace(/\\s+/g, "");
          });
        var hitCount = normalizedTexts.filter(
          function (text) {
            return headerWords.indexOf(text) !== -1;
          }
        ).length;

        return hitCount >= 2;
      }

      function canMergeContinuationTables(
        previousTable,
        nextTable
      ) {
        if (
          !previousTable ||
          !nextTable ||
          previousTable.columnCount < 2 ||
          previousTable.columnCount !==
            nextTable.columnCount ||
          !previousTable.hasHeader ||
          nextTable.hasHeader ||
          nextTable.caption ||
          !Array.isArray(nextTable.rows) ||
          nextTable.rows.length === 0
        ) {
          return false;
        }

        var firstRow = nextTable.rows[0];
        var firstCell =
          firstRow &&
          Array.isArray(firstRow.cells) &&
          firstRow.cells[0]
            ? safeText(firstRow.cells[0].text, "").trim()
            : "";

        return /^\\d+$/.test(firstCell);
      }

      function normalizeSpanValue(value) {
        var number = Number(value || 1);

        if (
          !Number.isInteger(number) ||
          number < 1 ||
          number > 100
        ) {
          return 1;
        }

        return number;
      }

      function looksNumericCell(value) {
        var text = String(value || "")
          .replace(/\\s+/g, "");

        if (!text) {
          return false;
        }

        return /^[₩￦]?[-+]?[\\d,.]+(?:원|%|건|명|회)?$/.test(text);
      }

      function renderDetailDisposition(caseData) {
        var parsed = caseData.dispositionParsed;
        var rawText = getDispositionText(caseData);

        if (
          rawText === "처분사항 정보가 없습니다." &&
          !hasParsedDisposition(parsed)
        ) {
          return;
        }

        var area =
          makeElement("section", "detail-disposition");

        area.appendChild(
          makeElement(
            "h3",
            "",
            "구조화된 처분 결과"
          )
        );

        area.appendChild(
          makeElement(
            "p",
            "detail-disposition-summary",
            rawText
          )
        );

        if (parsed && typeof parsed === "object") {
          appendDispositionGroup(
            area,
            "행정상 처분",
            parsed.administrative
          );
          appendDispositionGroup(
            area,
            "신분상 처분",
            parsed.personnel
          );
          appendDispositionGroup(
            area,
            "재정상 처분",
            parsed.financial
          );
        }

        detailDisposition.appendChild(area);
      }

      function appendDispositionGroup(
        parent,
        heading,
        items
      ) {
        if (!Array.isArray(items) || items.length === 0) {
          return;
        }

        var group =
          makeElement("div", "disposition-group");
        group.appendChild(
          makeElement("h4", "", heading)
        );

        var list =
          makeElement("ul", "disposition-list");

        items.forEach(function (item) {
          list.appendChild(
            makeElement(
              "li",
              "",
              formatDispositionItem(item)
            )
          );
        });

        group.appendChild(list);
        parent.appendChild(group);
      }

      function formatDispositionItem(item) {
        if (
          item === null ||
          item === undefined
        ) {
          return "내용 없음";
        }

        if (typeof item === "string") {
          return item;
        }

        if (
          typeof item.text === "string" &&
          item.text.trim()
        ) {
          return item.text.trim();
        }

        var parts = [];

        [
          item.org,
          item.target,
          item.action,
          item.type,
          item.name,
          item.amountText
        ].forEach(function (value) {
          if (
            value !== null &&
            value !== undefined &&
            String(value).trim()
          ) {
            parts.push(String(value).trim());
          }
        });

        if (
          item.amount !== null &&
          item.amount !== undefined &&
          Number.isFinite(Number(item.amount))
        ) {
          parts.push(
            Number(item.amount).toLocaleString("ko-KR") +
            "원"
          );
        }

        return parts.length
          ? Array.from(new Set(parts)).join(" ")
          : "처분 세부내용";
      }

      function appendDispositionBadges(
        parent,
        parsed
      ) {
        if (!parsed || typeof parsed !== "object") {
          return;
        }

        var badgeArea =
          makeElement("div", "disposition-badges");

        addDispositionBadge(
          badgeArea,
          "행정상",
          parsed.administrative
        );
        addDispositionBadge(
          badgeArea,
          "신분상",
          parsed.personnel
        );
        addDispositionBadge(
          badgeArea,
          "재정상",
          parsed.financial
        );

        if (badgeArea.children.length > 0) {
          parent.appendChild(badgeArea);
        }
      }

      function addDispositionBadge(
        parent,
        label,
        items
      ) {
        if (!Array.isArray(items) || items.length === 0) {
          return;
        }

        parent.appendChild(
          makeElement(
            "span",
            "disposition-badge",
            label + " " + items.length + "건"
          )
        );
      }

      function hasParsedDisposition(parsed) {
        return Boolean(
          parsed &&
          (
            (Array.isArray(parsed.administrative) &&
              parsed.administrative.length) ||
            (Array.isArray(parsed.personnel) &&
              parsed.personnel.length) ||
            (Array.isArray(parsed.financial) &&
              parsed.financial.length)
          )
        );
      }

      function getDispositionText(item) {
        var parsed = item && item.dispositionParsed;

        if (
          parsed &&
          typeof parsed.summaryText === "string" &&
          parsed.summaryText.trim()
        ) {
          return parsed.summaryText.trim();
        }

        if (
          item &&
          typeof item.disposition === "string" &&
          item.disposition.trim()
        ) {
          return item.disposition.trim();
        }

        return "처분사항 정보가 없습니다.";
      }

      function buildSearchGptText(query) {
        var topic = query ||
          "감사사례 관련 질문";

        return [
          "다음 주제의 감사사례를 참고하여 분석해 주세요.",
          "",
          "[검색 주제]",
          topic,
          "",
          "관련 근거와 유사사례를 구분하고, 실무자가 확인할 사항을 정리해 주세요."
        ].join("\\n");
      }

      function buildCardGptText(item) {
        return [
          "다음 감사사례를 참고하여 분석해 주세요.",
          "",
          "[현재 검색어]",
          safeText(
            searchInput.value,
            "검색어 없음"
          ),
          "",
          "[선택한 감사사례]",
          "사례 ID: " + safeText(item.id, "정보 없음"),
          "연도: " + formatYear(item.year),
          "제목: " + safeText(item.title, "제목 없음"),
          "출처 파일: " +
            safeText(item.sourceFile, "정보 없음"),
          "",
          "[문제점 미리보기]",
          safeText(item.preview, "내용 없음"),
          "",
          "[처분사항]",
          getDispositionText(item),
          "",
          "필요하면 연결된 지식베이스에서 관련 원문과 유사사례를 추가로 찾아 근거 중심으로 답변해 주세요."
        ].join("\\n");
      }

      function buildDetailGptText(caseData) {
        var lines = [
          "다음 감사사례의 전체 내용을 참고하여 분석해 주세요.",
          "",
          "[감사사례 기본정보]",
          "사례 ID: " +
            safeText(caseData.id, "정보 없음"),
          "연도: " + formatYear(caseData.year),
          "제목: " +
            safeText(caseData.title, "제목 없음"),
          "출처 파일: " +
            safeText(caseData.sourceFile, "정보 없음")
        ];
        var sections = Array.isArray(caseData.sections)
          ? caseData.sections
          : [];

        sections.forEach(function (section) {
          lines.push(
            "",
            "[" + safeText(section.heading, "본문") + "]"
          );

          var blocks = Array.isArray(section.blocks)
            ? section.blocks
            : [];

          blocks.forEach(function (block) {
            var blockText =
              convertDetailBlockToText(block);

            if (blockText) {
              lines.push(blockText);
            }
          });
        });

        lines.push(
          "",
          "[처분사항 요약]",
          getDispositionText(caseData),
          "",
          "관련 규정, 유사 감사사례, 실무상 유의사항을 구분하여 근거 중심으로 답변해 주세요."
        );

        return lines.join("\\n");
      }

      function convertDetailBlockToText(block) {
        if (!block || typeof block !== "object") {
          return "";
        }

        if (block.type === "table") {
          var rows = Array.isArray(block.rows)
            ? block.rows
            : [];
          var tableLines = rows.map(function (row) {
            var cells = Array.isArray(row && row.cells)
              ? row.cells
              : [];

            return cells
              .map(function (cell) {
                return safeText(
                  cell && cell.text,
                  ""
                );
              })
              .join(" | ");
          }).filter(Boolean);

          if (block.caption) {
            tableLines.unshift(
              "표: " + String(block.caption)
            );
          }

          return tableLines.join("\\n");
        }

        return safeText(block.text, "");
      }

      document.getElementById("analysisClose").addEventListener("click", function () {
        analysisDialog.close();
      });
      analysisDialog.addEventListener("click", function (event) {
        if (event.target === analysisDialog) analysisDialog.close();
      });
      analysisDialog.addEventListener("close", function () {
        cancelAnalysisRequest();
        if (!detailDialog.open) document.body.classList.remove("modal-open");
        if (lastAnalysisTrigger) lastAnalysisTrigger.focus();
      });
      document.getElementById("analysisClear").addEventListener("click", resetAnalysisConversation);
      document.getElementById("analysisForm").addEventListener("submit", function (event) {
        event.preventDefault();
        sendAnalysisQuestion();
      });

      function openAnalysisChat(context, label, trigger) {
        var nextContext = String(context || "").slice(0, ${MAX_ASK_CONTEXT_LENGTH});
        if (nextContext !== analysisContextText) {
          analysisContextText = nextContext;
          resetAnalysisConversation();
        }
        document.getElementById("analysisContext").textContent = label;
        lastAnalysisTrigger = trigger;
        if (!analysisDialog.open) analysisDialog.showModal();
        document.body.classList.add("modal-open");
        analysisInput.focus();
      }

      function cancelAnalysisRequest() {
        if (activeAnalysisController) activeAnalysisController.abort();
        activeAnalysisController = null;
        setAnalysisLoading(false);
      }

      function resetAnalysisConversation() {
        cancelAnalysisRequest();
        analysisHistory = [];
        analysisMessages.textContent = "";
        analysisInput.value = "";
        analysisError.hidden = true;
        appendAnalysisMessage("assistant", "궁금한 점을 질문해 주세요. 주요 문제점, 처분사항, 개선방안을 함께 살펴볼 수 있습니다.");
        analysisInput.focus();
      }

      function setAnalysisLoading(isLoading) {
        analysisSend.disabled = isLoading;
        analysisInput.disabled = isLoading;
        analysisStatus.hidden = !isLoading;
        analysisSend.textContent = isLoading ? "답변 작성 중…" : "질문 보내기";
        analysisMessages.setAttribute("aria-busy", String(isLoading));
      }

      function appendAnalysisMessage(role, text, sources) {
        var message = makeElement("article", "analysis-message " + role);
        message.appendChild(makeElement("strong", "analysis-message-label", role === "user" ? "나의 질문" : "AI 답변"));
        // Plain text rendering prevents model responses from injecting HTML.
        message.appendChild(makeElement("p", "analysis-message-text", text));
        if (Array.isArray(sources) && sources.length) {
          var sourceArea = makeElement("div", "analysis-sources");
          sourceArea.appendChild(makeElement("strong", "", "검색된 참고 사례"));
          var list = document.createElement("ul");
          sources.forEach(function (source) {
            list.appendChild(makeElement("li", "", [
              source.year ? source.year + "년" : "",
              safeText(source.title, "제목 없음"),
              safeText(source.sourceFile, "")
            ].filter(Boolean).join(" · ")));
          });
          sourceArea.appendChild(list);
          message.appendChild(sourceArea);
        }
        analysisMessages.appendChild(message);
        analysisMessages.scrollTop = analysisMessages.scrollHeight;
        return message;
      }

      async function sendAnalysisQuestion() {
        if (activeAnalysisController) return;
        var question = String(analysisInput.value || "").trim();
        if (!question || question.length > ${MAX_ASK_LENGTH}) {
          analysisError.textContent = "질문은 1~${MAX_ASK_LENGTH}자로 입력해 주세요.";
          analysisError.hidden = false;
          analysisInput.focus();
          return;
        }
        var controller = new AbortController();
        activeAnalysisController = controller;
        var userMessage = appendAnalysisMessage("user", question);
        analysisError.hidden = true;
        setAnalysisLoading(true);
        var completed = false;
        try {
          var response = await fetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ question: question, context: analysisContextText, history: analysisHistory }),
            signal: controller.signal
          });
          var data = await readJsonResponse(response);
          if (activeAnalysisController !== controller || !analysisDialog.open) return;
          if (!response.ok || data.success !== true || typeof data.answer !== "string") {
            throw new Error(data.message || "답변을 불러오지 못했습니다.");
          }
          appendAnalysisMessage("assistant", data.answer, data.sources);
          // Send only three completed turns; the visible transcript stays intact.
          analysisHistory.push({ role: "user", content: question },
            { role: "assistant", content: data.answer.slice(0, 2000) });
          analysisHistory = analysisHistory.slice(-6);
          analysisInput.value = "";
          completed = true;
        } catch (error) {
          if (activeAnalysisController === controller && error.name !== "AbortError") {
            analysisError.textContent = error.message || "답변을 불러오지 못했습니다. 다시 시도해 주세요.";
            analysisError.hidden = false;
          }
        } finally {
          if (!completed) userMessage.remove();
          if (activeAnalysisController === controller) {
            activeAnalysisController = null;
            setAnalysisLoading(false);
            analysisInput.focus();
          }
        }
      }

      async function readJsonResponse(response) {
        var text = await response.text();

        try {
          return JSON.parse(text);
        } catch {
          throw new Error(
            "서버 응답을 JSON으로 해석하지 못했습니다."
          );
        }
      }

      function resetDetail() {
        currentDetailData = null;
        detailGptButton.disabled = true;
        detailLoading.hidden = true;
        detailError.hidden = true;
        detailError.textContent = "";
        detailContent.hidden = true;
        detailMeta.textContent = "";
        detailSource.textContent = "";
        detailTableStatus.hidden = true;
        detailTableStatus.textContent = "";
        detailSections.textContent = "";
        detailDisposition.textContent = "";
      }

      function formatYear(value) {
        if (
          value === null ||
          value === undefined ||
          !String(value).trim()
        ) {
          return "연도 미상";
        }

        return String(value) + "년";
      }

      function makeElement(tagName, className, text) {
        var element =
          document.createElement(tagName);

        if (className) {
          element.className = className;
        }

        if (
          text !== undefined &&
          text !== null
        ) {
          element.textContent = String(text);
        }

        return element;
      }

      function safeText(value, fallback) {
        if (
          value === null ||
          value === undefined
        ) {
          return fallback;
        }

        var text = String(value).trim();
        return text || fallback;
      }

      function truncateText(value, maximumLength) {
        var text = String(value || "").trim();

        if (text.length <= maximumLength) {
          return text;
        }

        return (
          text.slice(0, maximumLength).trimEnd() +
          "…"
        );
      }

      function setSearchLoading(isLoading) {
        loadingBox.hidden = !isLoading;
        searchButton.disabled = isLoading;
        yearFilter.disabled = isLoading;
        dispositionCategory.disabled = isLoading;
        dispositionType.disabled =
          isLoading ||
          !String(
            dispositionCategory.value || ""
          ).trim();
        filterResetButton.disabled = isLoading;
        searchButton.textContent =
          isLoading ? "검색 중..." : "검색";
      }

      function clearSearchResults() {
        errorBox.hidden = true;
        errorBox.textContent = "";
        resultsSection.hidden = true;
        emptyBox.hidden = true;
        resultsMeta.textContent = "";
        resultList.textContent = "";
      }

      function showSearchError(message) {
        resultsSection.hidden = true;
        loadingBox.hidden = true;
        errorBox.textContent = message;
        errorBox.hidden = false;
      }
    })();
  </script>
</body>
</html>`;
}

function getStatisticsPage() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>통계 현황 | ${APP_NAME}</title>
  <style>
    :root {
      --navy-950: #102a43;
      --navy-900: #153e5c;
      --navy-800: #164e75;
      --navy-700: #1d638f;
      --blue-100: #e8f4fb;
      --blue-200: #c9e5f5;
      --gray-50: #f7f9fb;
      --gray-100: #eef2f6;
      --gray-200: #d9e2ec;
      --gray-300: #bcccdc;
      --gray-500: #627d98;
      --gray-700: #334e68;
      --gray-900: #243b53;
      --white: #ffffff;
      --green-100: #e9f8ef;
      --green-800: #176b3a;
      --amber-100: #fff7e6;
      --amber-800: #8a4b08;
      --red-100: #fff1f1;
      --red-700: #b42318;
      --shadow: 0 10px 28px rgba(16, 42, 67, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--gray-900);
      background: var(--gray-50);
      font-family:
        "Noto Sans KR",
        "Malgun Gothic",
        "Apple SD Gothic Neo",
        system-ui,
        sans-serif;
      line-height: 1.6;
    }

    a {
      color: inherit;
    }

    button {
      font: inherit;
    }

    [hidden] {
      display: none !important;
    }

    .page-width {
      width: min(1120px, calc(100% - 40px));
      margin: 0 auto;
    }

    header {
      color: var(--white);
      background: linear-gradient(
        135deg,
        var(--navy-950),
        var(--navy-700)
      );
    }

    .header-inner {
      padding: 36px 0 32px;
    }

    .header-label {
      display: inline-block;
      margin-bottom: 8px;
      color: #c9e6f7;
      font-size: 0.875rem;
      font-weight: 800;
    }

    h1 {
      margin: 0;
      font-size: clamp(1.75rem, 4vw, 2.45rem);
      line-height: 1.25;
      letter-spacing: -0.04em;
    }

    .header-description {
      margin: 11px 0 0;
      color: #d9e8f2;
      font-size: 1rem;
    }

    .top-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 21px;
    }

    .top-nav a {
      padding: 8px 13px;
      color: #e7f3fa;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 800;
      text-decoration: none;
    }

    .top-nav a:hover,
    .top-nav a[aria-current="page"] {
      color: var(--navy-950);
      background: var(--white);
      border-color: var(--white);
    }

    main {
      padding: 34px 0 64px;
    }

    .page-heading-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    .page-heading {
      margin: 0;
      color: var(--navy-950);
      font-size: 1.5rem;
    }

    .generated-at {
      margin: 4px 0 0;
      color: var(--gray-500);
      font-size: 0.9rem;
    }

    .refresh-button {
      min-height: 42px;
      padding: 8px 15px;
      color: var(--navy-800);
      background: var(--white);
      border: 1px solid var(--gray-300);
      border-radius: 8px;
      font-weight: 800;
      white-space: nowrap;
    }

    .refresh-button:hover:not(:disabled) {
      background: var(--blue-100);
      border-color: var(--navy-700);
    }

    .refresh-button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    .loading-box,
    .error-box {
      margin: 22px 0;
      padding: 18px 20px;
      border-radius: 10px;
      font-weight: 800;
    }

    .loading-box {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--navy-900);
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
    }

    .spinner {
      width: 21px;
      height: 21px;
      flex: 0 0 auto;
      border: 3px solid #a7d2e9;
      border-top-color: var(--navy-700);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error-box {
      color: var(--red-700);
      background: var(--red-100);
      border: 1px solid #fecdca;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }

    .summary-card {
      min-height: 132px;
      padding: 20px;
      background: var(--white);
      border: 1px solid var(--gray-200);
      border-top: 4px solid var(--navy-700);
      border-radius: 12px;
      box-shadow: 0 6px 18px rgba(16, 42, 67, 0.05);
    }

    .summary-label {
      display: block;
      color: var(--gray-700);
      font-size: 0.9rem;
      font-weight: 800;
    }

    .summary-value {
      display: block;
      margin-top: 9px;
      color: var(--navy-950);
      font-size: 2rem;
      font-weight: 900;
      line-height: 1.15;
      font-variant-numeric: tabular-nums;
    }

    .summary-unit {
      margin-left: 3px;
      font-size: 0.95rem;
      font-weight: 800;
    }

    .panel {
      margin-top: 20px;
      padding: 24px;
      background: var(--white);
      border: 1px solid var(--gray-200);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }

    .panel-heading {
      margin: 0;
      color: var(--navy-950);
      font-size: 1.25rem;
    }

    .panel-description {
      margin: 5px 0 20px;
      color: var(--gray-500);
      font-size: 0.92rem;
    }

    .donut-layout {
      display: grid;
      grid-template-columns: minmax(300px, 420px) 1fr;
      align-items: center;
      gap: 34px;
    }

    .donut-wrap {
      display: flex;
      justify-content: center;
      padding: 12px;
    }

    .donut-chart {
      position: relative;
      width: min(350px, 74vw);
      aspect-ratio: 1;
      border-radius: 50%;
      background: conic-gradient(#d9e2ec 0% 100%);
      box-shadow: inset 0 0 0 1px rgba(16, 42, 67, 0.04);
    }

    .donut-center {
      position: absolute;
      inset: 25%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      text-align: center;
      background: var(--white);
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(16, 42, 67, 0.05);
    }

    .donut-center-label {
      color: var(--gray-500);
      font-size: 0.88rem;
      font-weight: 800;
    }

    .donut-center-value {
      margin-top: 3px;
      color: var(--navy-950);
      font-size: 2.35rem;
      font-weight: 900;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }

    .donut-label-layer {
      position: absolute;
      inset: 0;
      z-index: 2;
      pointer-events: none;
    }

    .donut-segment-label {
      position: absolute;
      width: 78px;
      padding: 4px 3px 3px;
      color: var(--navy-950);
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid rgba(16, 42, 67, 0.1);
      border-radius: 999px;
      box-shadow: 0 2px 6px rgba(16, 42, 67, 0.14);
      text-align: center;
      transform: translate(-50%, -50%);
    }

    .donut-segment-name,
    .donut-segment-percent {
      display: block;
      white-space: nowrap;
      line-height: 1.12;
    }

    .donut-segment-name {
      font-size: 0.68rem;
      font-weight: 900;
      letter-spacing: -0.04em;
    }

    .donut-segment-percent {
      margin-top: 2px;
      color: var(--gray-700);
      font-size: 0.64rem;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
    }

    .legend-list {
      display: grid;
      gap: 2px;
    }

    .legend-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 10px 7px;
      border-bottom: 1px solid var(--gray-200);
    }

    .legend-color {
      width: 13px;
      height: 13px;
      border-radius: 4px;
    }

    .legend-name {
      color: var(--gray-900);
      font-weight: 800;
    }

    .legend-value {
      color: var(--navy-900);
      font-weight: 900;
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }

    .year-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
      gap: 26px;
      align-items: start;
    }

    .year-bars {
      display: grid;
      gap: 13px;
    }

    .year-bar-row {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 52px;
      align-items: center;
      gap: 10px;
    }

    .year-bar-label,
    .year-bar-value {
      color: var(--gray-700);
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }

    .year-bar-value {
      text-align: right;
    }

    .year-bar-track {
      height: 22px;
      overflow: hidden;
      background: var(--gray-100);
      border-radius: 999px;
    }

    .year-bar-fill {
      height: 100%;
      min-width: 4px;
      background: linear-gradient(
        90deg,
        var(--navy-700),
        #2b8fbd
      );
      border-radius: 999px;
    }

    .data-table-wrap {
      overflow-x: auto;
      border: 1px solid var(--gray-200);
      border-radius: 9px;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }

    .data-table th,
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--gray-200);
      text-align: left;
    }

    .data-table th {
      color: var(--navy-950);
      background: var(--blue-100);
      font-weight: 900;
    }

    .data-table td:last-child,
    .data-table th:last-child {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .data-table tr:last-child td {
      border-bottom: 0;
    }

    .disposition-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .disposition-card {
      padding: 20px;
      border-radius: 11px;
    }

    .disposition-card.admin {
      color: var(--navy-900);
      background: var(--blue-100);
      border: 1px solid var(--blue-200);
    }

    .disposition-card.personnel {
      color: var(--green-800);
      background: var(--green-100);
      border: 1px solid #b9e5cc;
    }

    .disposition-card.financial {
      color: var(--amber-800);
      background: var(--amber-100);
      border: 1px solid #f0d9ad;
    }

    .disposition-card-label {
      font-size: 0.92rem;
      font-weight: 900;
    }

    .disposition-card-value {
      display: block;
      margin-top: 8px;
      font-size: 2rem;
      font-weight: 900;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }

    .statistics-note {
      margin: 16px 0 0;
      color: var(--gray-500);
      font-size: 0.87rem;
    }

    footer {
      padding: 24px 20px;
      color: var(--gray-500);
      text-align: center;
      font-size: 0.875rem;
    }

    @media (max-width: 860px) {
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .donut-layout,
      .year-layout {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 600px) {
      .page-width {
        width: min(100% - 28px, 1120px);
      }

      .header-inner {
        padding: 29px 0 27px;
      }

      main {
        padding: 24px 0 48px;
      }

      .page-heading-row {
        align-items: flex-start;
        flex-direction: column;
      }

      .summary-grid,
      .disposition-grid {
        grid-template-columns: 1fr;
      }

      .summary-card {
        min-height: 112px;
      }

      .panel {
        padding: 18px;
      }

      .donut-layout {
        gap: 16px;
      }

      .donut-segment-label {
        width: 68px;
        padding: 3px 2px;
      }

      .donut-segment-name {
        font-size: 0.61rem;
      }

      .donut-segment-percent {
        font-size: 0.59rem;
      }

      .legend-item {
        padding-left: 2px;
        padding-right: 2px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
  </style>
</head>

<body>
  <header>
    <div class="page-width header-inner">
      <span class="header-label">
        대구교통공사 내부 업무용
      </span>
      <h1>${APP_NAME}</h1>
      <p class="header-description">
        연도별·분류별 감사사례와 처분 현황을 확인합니다.
      </p>
      <nav class="top-nav" aria-label="주요 메뉴">
        <a href="/">사례 검색</a>
        <a href="/statistics" aria-current="page">통계 현황</a>
      </nav>
    </div>
  </header>

  <main class="page-width">
    <div class="page-heading-row">
      <div>
        <h2 class="page-heading">감사사례 통계 현황</h2>
        <p id="generatedAt" class="generated-at">
          최신 통계를 불러오는 중입니다.
        </p>
      </div>
      <button
        id="refreshButton"
        class="refresh-button"
        type="button"
      >
        새로고침
      </button>
    </div>

    <div
      id="loadingBox"
      class="loading-box"
      role="status"
      aria-live="polite"
    >
      <span class="spinner" aria-hidden="true"></span>
      <span>감사사례 통계를 집계하고 있습니다.</span>
    </div>

    <div
      id="errorBox"
      class="error-box"
      role="alert"
      hidden
    ></div>

    <div id="statisticsContent" hidden>
      <section
        class="summary-grid"
        aria-label="전체 감사사례 현황"
      >
        <article class="summary-card">
          <span class="summary-label">전체 감사사례</span>
          <span class="summary-value">
            <span id="totalCases">0</span>
            <span class="summary-unit">건</span>
          </span>
        </article>

        <article class="summary-card">
          <span class="summary-label">원본 감사파일</span>
          <span class="summary-value">
            <span id="totalFiles">0</span>
            <span class="summary-unit">개</span>
          </span>
        </article>

        <article class="summary-card">
          <span class="summary-label">감사 연도</span>
          <span class="summary-value">
            <span id="yearCount">0</span>
            <span class="summary-unit">개 연도</span>
          </span>
        </article>

        <article class="summary-card">
          <span class="summary-label">분류 완료 사례</span>
          <span class="summary-value">
            <span id="classifiedCases">0</span>
            <span class="summary-unit">건</span>
          </span>
        </article>
      </section>

      <section class="panel" aria-labelledby="categoryTitle">
        <h2 id="categoryTitle" class="panel-heading">
          감사사례 분류 현황
        </h2>
        <p class="panel-description">
          audit2026의 기존 8개 분류 규칙으로 집계한 결과입니다.
        </p>

        <div class="donut-layout">
          <div class="donut-wrap">
            <div
              id="donutChart"
              class="donut-chart"
              role="img"
              aria-label="감사사례 분류 도넛 차트"
            >
              <div
                id="donutLabelLayer"
                class="donut-label-layer"
                aria-hidden="true"
              ></div>
              <div class="donut-center">
                <span class="donut-center-label">총 분류 사례</span>
                <strong
                  id="donutTotal"
                  class="donut-center-value"
                >0</strong>
              </div>
            </div>
          </div>

          <div
            id="categoryLegend"
            class="legend-list"
            aria-label="분류별 사례 수와 비율"
          ></div>
        </div>
      </section>

      <section class="panel" aria-labelledby="yearTitle">
        <h2 id="yearTitle" class="panel-heading">
          연도별 감사사례 현황
        </h2>
        <p class="panel-description">
          등록된 감사사례를 감사 연도별로 집계했습니다.
        </p>

        <div class="year-layout">
          <div
            id="yearBars"
            class="year-bars"
            aria-label="연도별 사례 수 막대그래프"
          ></div>

          <div class="data-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">연도</th>
                  <th scope="col">사례 수</th>
                </tr>
              </thead>
              <tbody id="yearTableBody"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel" aria-labelledby="dispositionTitle">
        <h2 id="dispositionTitle" class="panel-heading">
          처분 구분 현황
        </h2>
        <p class="panel-description">
          한 사례에 여러 처분이 포함될 수 있어 전체 사례 수와
          처분 합계는 일치하지 않을 수 있습니다.
        </p>

        <div class="disposition-grid">
          <article class="disposition-card admin">
            <span class="disposition-card-label">
              행정상 처분(부서)
            </span>
            <strong class="disposition-card-value">
              <span id="administrativeCount">0</span>건
            </strong>
          </article>

          <article class="disposition-card personnel">
            <span class="disposition-card-label">
              신분상 처분(직원)
            </span>
            <strong class="disposition-card-value">
              <span id="personnelCount">0</span>명
            </strong>
          </article>

          <article class="disposition-card financial">
            <span class="disposition-card-label">
              재정상 처분
            </span>
            <strong class="disposition-card-value">
              <span id="financialCount">0</span>건
            </strong>
          </article>
        </div>

        <p class="statistics-note">
          행정상은 부서별 처분 건수, 신분상은 파싱된 직원 인원,
          재정상은 회수·환수 등 재정 조치 건수를 표시합니다.
        </p>
      </section>
    </div>
  </main>

  <footer>
    종합감사 디지털 사례집 · 통계 화면 · v${APP_VERSION}
  </footer>

  <script>
    (function () {
      var CATEGORY_COLORS = {
        "계약·회계·지출": "#4f46e5",
        "자산·물품·재고관리": "#0ea5e9",
        "복무·근태·급여": "#10b981",
        "안전·보건·소방": "#f59e0b",
        "장비·차량·유지관리": "#ef4444",
        "제도·운영개선": "#8b5cf6",
        "시설·공사·하자관리": "#14b8a6",
        "개인정보·보안": "#f97316",
        "미분류": "#6b7280"
      };

      var CATEGORY_SHORT_LABELS = {
        "계약·회계·지출": "계약·회계",
        "자산·물품·재고관리": "자산·물품",
        "복무·근태·급여": "복무·근태",
        "안전·보건·소방": "안전·보건",
        "장비·차량·유지관리": "장비·차량",
        "제도·운영개선": "제도·운영개선",
        "시설·공사·하자관리": "시설·공사",
        "개인정보·보안": "개인정보",
        "미분류": "미분류"
      };

      var loadingBox =
        document.getElementById("loadingBox");
      var errorBox =
        document.getElementById("errorBox");
      var statisticsContent =
        document.getElementById("statisticsContent");
      var refreshButton =
        document.getElementById("refreshButton");
      var generatedAt =
        document.getElementById("generatedAt");

      refreshButton.addEventListener(
        "click",
        loadStatistics
      );

      loadStatistics();

      async function loadStatistics() {
        setLoading(true);
        errorBox.hidden = true;
        errorBox.textContent = "";

        try {
          var response = await fetch("/api/statistics", {
            headers: {
              Accept: "application/json"
            }
          });
          var data = await readJsonResponse(response);

          if (!response.ok || data.success === false) {
            throw new Error(
              data.message ||
              data.error ||
              "통계 데이터를 불러오지 못했습니다."
            );
          }

          renderStatistics(data);
          statisticsContent.hidden = false;
        } catch (error) {
          statisticsContent.hidden = true;
          errorBox.textContent =
            error instanceof Error
              ? error.message
              : "통계 데이터를 불러오지 못했습니다.";
          errorBox.hidden = false;
        } finally {
          setLoading(false);
        }
      }

      function renderStatistics(data) {
        setNumber("totalCases", data.totalCases);
        setNumber("totalFiles", data.totalUploadFiles);
        setNumber("yearCount", data.yearCount);
        setNumber(
          "classifiedCases",
          data.classifiedCases
        );

        var disposition =
          data.dispositionCounts &&
          typeof data.dispositionCounts === "object"
            ? data.dispositionCounts
            : {};

        setNumber(
          "administrativeCount",
          disposition.administrative
        );
        setNumber(
          "personnelCount",
          disposition.personnel
        );
        setNumber(
          "financialCount",
          disposition.financial
        );

        renderCategoryDonut(
          Array.isArray(data.categoryStats)
            ? data.categoryStats
            : []
        );
        renderYearStatistics(
          Array.isArray(data.yearStats)
            ? data.yearStats
            : []
        );

        generatedAt.textContent =
          "통계 생성 시각: " +
          formatDateTime(data.generatedAt);
      }

      function renderCategoryDonut(rawItems) {
        var items = rawItems
          .map(function (item) {
            return {
              category: String(
                item && item.category || "미분류"
              ),
              count: normalizeNumber(
                item && item.count
              )
            };
          })
          .filter(function (item) {
            return item.count > 0;
          });
        var total = items.reduce(
          function (sum, item) {
            return sum + item.count;
          },
          0
        );
        var accumulated = 0;
        var gradientParts = [];
        var legend =
          document.getElementById("categoryLegend");
        var labelLayer =
          document.getElementById("donutLabelLayer");
        var donut =
          document.getElementById("donutChart");

        legend.textContent = "";
        labelLayer.textContent = "";
        setNumber("donutTotal", total);

        items.forEach(function (item, index) {
          var percent =
            total > 0 ? item.count / total * 100 : 0;
          var start = accumulated;
          var end = accumulated + percent;
          var color =
            CATEGORY_COLORS[item.category] ||
            fallbackColor(index);

          gradientParts.push(
            color +
            " " +
            start.toFixed(2) +
            "% " +
            end.toFixed(2) +
            "%"
          );
          accumulated = end;

          legend.appendChild(
            createLegendItem(
              item,
              percent,
              color
            )
          );
          labelLayer.appendChild(
            createDonutSegmentLabel(
              item,
              percent,
              start,
              end
            )
          );
        });

        donut.style.background = gradientParts.length
          ? "conic-gradient(" +
            gradientParts.join(", ") +
            ")"
          : "conic-gradient(#d9e2ec 0% 100%)";
        donut.setAttribute(
          "aria-label",
          "감사사례 분류 도넛 차트. 총 " +
          formatNumber(total) +
          "건"
        );
      }

      function createLegendItem(item, percent, color) {
        var row = makeElement("div", "legend-item");
        var colorBox =
          makeElement("span", "legend-color");
        colorBox.style.background = color;

        row.appendChild(colorBox);
        row.appendChild(
          makeElement(
            "span",
            "legend-name",
            item.category
          )
        );
        row.appendChild(
          makeElement(
            "span",
            "legend-value",
            formatNumber(item.count) +
            "건 (" +
            percent.toFixed(1) +
            "%)"
          )
        );
        return row;
      }

      function createDonutSegmentLabel(
        item,
        percent,
        start,
        end
      ) {
        var label = makeElement(
          "span",
          "donut-segment-label"
        );
        var middlePercent = (start + end) / 2;
        var angle =
          (middlePercent * 3.6 - 90) *
          Math.PI /
          180;
        var radius = 37.5;
        var left =
          50 + Math.cos(angle) * radius;
        var top =
          50 + Math.sin(angle) * radius;

        label.style.left = left.toFixed(2) + "%";
        label.style.top = top.toFixed(2) + "%";
        label.appendChild(
          makeElement(
            "span",
            "donut-segment-name",
            CATEGORY_SHORT_LABELS[item.category] ||
              item.category
          )
        );
        label.appendChild(
          makeElement(
            "span",
            "donut-segment-percent",
            percent.toFixed(1) + "%"
          )
        );
        return label;
      }

      function renderYearStatistics(rawItems) {
        var items = rawItems
          .map(function (item) {
            return {
              year: String(item && item.year || "미상"),
              count: normalizeNumber(
                item && item.count
              )
            };
          })
          .sort(function (a, b) {
            return Number(b.year) - Number(a.year);
          });
        var maximum = items.reduce(
          function (max, item) {
            return Math.max(max, item.count);
          },
          0
        );
        var bars =
          document.getElementById("yearBars");
        var tableBody =
          document.getElementById("yearTableBody");

        bars.textContent = "";
        tableBody.textContent = "";

        items.forEach(function (item) {
          bars.appendChild(
            createYearBar(item, maximum)
          );

          var row = document.createElement("tr");
          row.appendChild(
            makeElement(
              "td",
              "",
              item.year + "년"
            )
          );
          row.appendChild(
            makeElement(
              "td",
              "",
              formatNumber(item.count) + "건"
            )
          );
          tableBody.appendChild(row);
        });
      }

      function createYearBar(item, maximum) {
        var row =
          makeElement("div", "year-bar-row");
        var track =
          makeElement("div", "year-bar-track");
        var fill =
          makeElement("div", "year-bar-fill");
        var width =
          maximum > 0
            ? item.count / maximum * 100
            : 0;

        fill.style.width = width.toFixed(2) + "%";
        track.appendChild(fill);

        row.appendChild(
          makeElement(
            "span",
            "year-bar-label",
            item.year
          )
        );
        row.appendChild(track);
        row.appendChild(
          makeElement(
            "span",
            "year-bar-value",
            formatNumber(item.count) + "건"
          )
        );
        return row;
      }

      function setNumber(elementId, value) {
        var element = document.getElementById(elementId);

        if (element) {
          element.textContent =
            formatNumber(normalizeNumber(value));
        }
      }

      function normalizeNumber(value) {
        var number = Number(value || 0);
        return Number.isFinite(number) && number >= 0
          ? number
          : 0;
      }

      function formatNumber(value) {
        return Number(value || 0).toLocaleString("ko-KR");
      }

      function formatDateTime(value) {
        if (!value) {
          return "정보 없음";
        }

        var date = new Date(value);

        if (Number.isNaN(date.getTime())) {
          return String(value);
        }

        return date.toLocaleString("ko-KR", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        });
      }

      function fallbackColor(index) {
        var colors = [
          "#4f46e5",
          "#0ea5e9",
          "#10b981",
          "#f59e0b",
          "#ef4444",
          "#8b5cf6",
          "#14b8a6",
          "#f97316",
          "#6b7280"
        ];
        return colors[index % colors.length];
      }

      function makeElement(tagName, className, text) {
        var element = document.createElement(tagName);

        if (className) {
          element.className = className;
        }

        if (text !== undefined && text !== null) {
          element.textContent = String(text);
        }

        return element;
      }

      async function readJsonResponse(response) {
        var text = await response.text();

        if (!text) {
          return {};
        }

        try {
          return JSON.parse(text);
        } catch (error) {
          throw new Error(
            "서버 응답을 읽을 수 없습니다."
          );
        }
      }

      function setLoading(isLoading) {
        loadingBox.hidden = !isLoading;
        refreshButton.disabled = isLoading;
        refreshButton.textContent =
          isLoading ? "불러오는 중..." : "새로고침";
      }
    })();
  </script>
</body>
</html>`;
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

function jsonResponse(
  data,
  status = 200,
  additionalHeaders = {}
) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders,
    },
  });
}
