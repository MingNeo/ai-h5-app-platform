// 浏览器内的全局登录弹窗。登录流程参考主站前端实现：
// 手机号 + 短信验证码（极验 / 图形验证码），直接调用主站登录接口，成功后主站写入基础域名下的 cookie。
import { config } from './config'
import { PlatformError } from './errors'
import { rawApi } from './http'
import css from './login-ui.css'

declare global {
  interface Window {
    initGeetest?: (opts: Record<string, unknown>, cb: (captcha: any) => void) => void
  }
}

const LOGIN_ORIGIN_FALLBACK = 'https://zhiyou.smzdm.com'
const loginBase = () => config.login.loginOrigin || LOGIN_ORIGIN_FALLBACK

async function loginPost(path: string, params: Record<string, string>) {
  const res = await fetch(`${loginBase()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  return res.json() as Promise<{ error_code: number, error_msg?: string, captcha_type?: string, data?: any }>
}

async function loadGeetest(): Promise<void> {
  if (window.initGeetest)
    return
  // 官方 gt.js 加载器（v0.4.8），首次登录时才执行
  await import('./geetest-loader.js')
}

function geetestVerify(slot: HTMLElement): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    fetch(`${loginBase()}/user/getgeetest/captcha_init_v3?scene=login&rand=${Math.random().toString(36).slice(2)}`, { credentials: 'include' })
      .then(r => r.json())
      .then(async (body) => {
        const data = body?.gt ? body : body?.data
        await loadGeetest()
        window.initGeetest!({
          gt: data.gt,
          challenge: data.challenge,
          offline: !data.success,
          new_captcha: true,
          product: 'bind',
        }, (captcha) => {
          captcha
            .appendTo(slot)
            .onReady(() => captcha.verify())
            .onSuccess(() => {
              const result = captcha.getValidate()
              if (result) {
                captcha.destroy?.()
                resolve(result)
              }
              else {
                reject(new Error('验证失败'))
              }
            })
            .onError(() => reject(new Error('验证组件加载失败')))
            .onClose?.(() => reject(new Error('已取消验证')))
        })
      })
      .catch(reject)
  })
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: Array<Node | string> = []) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text')
      el.textContent = v
    else el.setAttribute(k, v)
  }
  for (const c of children)
    el.append(c)
  return el
}

function mount() {
  const host = h('div', { 'data-app-login': '' })
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;'
  const root = host.attachShadow({ mode: 'open' })
  root.append(h('style', { text: css }))
  document.body.append(host)
  return { host, root }
}

function toast(root: ShadowRoot, text: string) {
  const t = h('div', { class: 'toast', text })
  root.append(t)
  setTimeout(() => t.remove(), 2000)
}

const PHONE_RE = /^1[3-9]\d{9}$/

/** 显示登录弹窗；登录成功 resolve，关闭 reject(LOGIN_CANCELLED) */
export function showLoginModal(): Promise<void> {
  return new Promise((resolve, reject) => {
    const { host, root } = mount()
    const close = (ok: boolean) => {
      host.remove()
      ok ? resolve() : reject(new PlatformError('LOGIN_CANCELLED', '已取消登录', 499))
    }

    const mobile = h('input', { type: 'tel', maxlength: '11', placeholder: '请输入手机号', autocomplete: 'tel' }) as HTMLInputElement
    const code = h('input', { type: 'tel', maxlength: '6', placeholder: '请输入短信验证码', autocomplete: 'one-time-code' }) as HTMLInputElement
    const sendBtn = h('button', { class: 'link', type: 'button', text: '发送验证码' }) as HTMLButtonElement
    const agree = h('input', { type: 'checkbox' }) as HTMLInputElement
    const submit = h('button', { class: 'primary', type: 'button', text: '登录' }) as HTMLButtonElement
    const errorEl = h('div', { class: 'error' })
    const closeBtn = h('button', { class: 'close', type: 'button', 'aria-label': '关闭', text: '×' })
    const captchaRow = h('div', { class: 'row captcha hidden' })
    const captchaInput = h('input', { maxlength: '4', placeholder: '图形验证码' }) as HTMLInputElement
    const captchaImg = h('img', { alt: '图形验证码' }) as HTMLImageElement
    captchaRow.append(captchaInput, captchaImg)
    const geetestSlot = h('div', { class: 'geetest hidden' })

    const agreementLinks: Array<Node | string> = ['我已阅读并同意']
    if (config.login.agreementUrl)
      agreementLinks.push(h('a', { href: config.login.agreementUrl, target: '_blank', text: '《用户协议》' }))
    if (config.login.privacyUrl)
      agreementLinks.push(h('a', { href: config.login.privacyUrl, target: '_blank', text: '《隐私政策》' }))
    if (agreementLinks.length === 1)
      agreementLinks.push('用户协议与隐私政策')

    const fallbackBase = config.login.loginMobileOrigin || config.login.loginOrigin || LOGIN_ORIGIN_FALLBACK
    const fallbackUrl = `${fallbackBase}/user/login?redirect_to=${encodeURIComponent(location.href)}`
    const fallback = h('a', {
      class: 'fallback',
      href: fallbackUrl,
      target: '_top',
      rel: 'noopener',
      text: '无法登录？使用登录页',
    })
    fallback.addEventListener('click', (e) => {
      // 后台预览在 iframe 里：普通跳转只会刷新 iframe，必须导航顶层窗口
      try {
        if (window.top && window.top !== window) {
          e.preventDefault()
          window.top.location.href = fallbackUrl
        }
      }
      catch {}
    })

    const devLogin = h('button', { class: 'link dev', type: 'button', text: '使用模拟账号登录（调试）' }) as HTMLButtonElement

    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true' }, [
      closeBtn,
      h('div', { class: 'title', text: '登录后继续' }),
      h('div', { class: 'row' }, [mobile]),
      captchaRow,
      geetestSlot,
      h('div', { class: 'row' }, [code, sendBtn]),
      errorEl,
      submit,
      h('label', { class: 'agree' }, [agree, ...agreementLinks]),
      config.mockLogin ? devLogin : '',
      fallback,
    ])
    root.append(h('div', { class: 'mask' }), panel)
    closeBtn.addEventListener('click', () => close(false))
    root.querySelector('.mask')!.addEventListener('click', () => close(false))
    setTimeout(() => mobile.focus(), 50)

    const setError = (msg: string) => {
      errorEl.textContent = msg
    }

    let countdownTimer = 0
    const startCountdown = () => {
      let left = 60
      sendBtn.disabled = true
      sendBtn.textContent = `${left}s`
      countdownTimer = window.setInterval(() => {
        left--
        if (left <= 0) {
          clearInterval(countdownTimer)
          sendBtn.disabled = false
          sendBtn.textContent = '重新发送'
        }
        else {
          sendBtn.textContent = `${left}s`
        }
      }, 1000)
    }

    const requestSms = async (extra: Record<string, string>, allowCaptchaChallenge = false) => {
      const res = await loginPost('/user/login/ajax_get_mobile_code/', { mobile: mobile.value.trim(), ...extra })
      // 110202：需要先完成人机验证（验证码类型在响应顶层的 captcha_type 里）
      if (res.error_code === 110202 && allowCaptchaChallenge)
        return res
      if (res.error_code)
        throw new Error(res.error_msg || '验证码发送失败')
      return res
    }

    sendBtn.addEventListener('click', async () => {
      setError('')
      const m = mobile.value.trim()
      if (!PHONE_RE.test(m))
        return setError('请输入正确的手机号')
      sendBtn.disabled = true
      try {
        if (!captchaRow.classList.contains('hidden')) {
          if (captchaInput.value.length !== 4)
            throw new Error('请输入 4 位图形验证码')
          await requestSms({ captcha: captchaInput.value })
          toast(root, '验证码已发送')
          startCountdown()
          return
        }
        const first = await requestSms({}, true)
        const type = first.captcha_type ?? first.data?.captcha_type
        if (type === 'geetest') {
          geetestSlot.classList.remove('hidden')
          const validate = await geetestVerify(geetestSlot)
          await requestSms(validate)
          geetestSlot.classList.add('hidden')
          geetestSlot.replaceChildren()
        }
        else if (type === 'text') {
          captchaRow.classList.remove('hidden')
          captchaImg.src = `${loginBase()}/user/getcaptcha/en/login_mobile_quick/?t=${Date.now()}`
          captchaImg.onclick = () => { captchaImg.src = `${loginBase()}/user/getcaptcha/en/login_mobile_quick/?t=${Date.now()}` }
          sendBtn.disabled = false
          setError('请输入图形验证码后再次点击发送')
          return
        }
        else if (first.error_code === 110202) {
          throw new Error('需要完成人机验证，请刷新后重试')
        }
        toast(root, '验证码已发送')
        startCountdown()
      }
      catch (e) {
        geetestSlot.classList.add('hidden')
        geetestSlot.replaceChildren()
        sendBtn.disabled = false
        setError(e instanceof TypeError ? '网络异常，可使用下方登录页登录' : (e as Error).message)
      }
    })

    devLogin.addEventListener('click', async () => {
      setError('')
      devLogin.disabled = true
      try {
        await rawApi('/dev/mock-login', { method: 'POST', body: {} })
        clearInterval(countdownTimer)
        close(true)
      }
      catch (e) {
        devLogin.disabled = false
        setError((e as Error).message || '模拟登录失败')
      }
    })

    submit.addEventListener('click', async () => {
      setError('')
      const m = mobile.value.trim()
      if (!PHONE_RE.test(m))
        return setError('请输入正确的手机号')
      if (!code.value.trim())
        return setError('请输入短信验证码')
      if (!agree.checked)
        return setError('请先阅读并同意用户协议与隐私政策')
      submit.disabled = true
      submit.textContent = '登录中…'
      try {
        const res = await loginPost('/user/login/ajax_quick_check', {
          mobile: m,
          mobile_code: code.value.trim(),
          from_activity: config.login.fromActivity,
        })
        if (res.error_code)
          throw new Error(res.error_msg || '登录失败')
        clearInterval(countdownTimer)
        close(true)
      }
      catch (e) {
        setError(e instanceof TypeError ? '网络异常，可使用下方登录页登录' : (e as Error).message)
        submit.disabled = false
        submit.textContent = '登录'
      }
    })
  })
}

/** requireLogin 应用取消登录后的遮挡层 */
export function showBlocker(message: string): Promise<void> {
  return new Promise((resolve) => {
    const { host, root } = mount()
    const btn = h('button', { class: 'primary', type: 'button', text: '去登录' })
    root.append(h('div', { class: 'blocker' }, [h('div', { class: 'blocker-text', text: message }), btn]))
    btn.addEventListener('click', () => {
      host.remove()
      resolve()
    })
  })
}
