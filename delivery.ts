import { env } from '../../config/env';
import { AppError } from '../../lib/errors';

export interface OtpDelivery {
  send(phone: string, code: string): Promise<void>;
}

class DemoDelivery implements OtpDelivery {
  async send(): Promise<void> {
    // Demo mode: nothing is sent. The code is DEMO_OTP_CODE.
  }
}

/**
 * WhatsApp Cloud API "authentication" template with a copy-code button.
 * The template body must contain one variable ({{1}}) for the code.
 */
class WhatsAppDelivery implements OtpDelivery {
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly templateName: string,
    private readonly language: string
  ) {}

  async send(phone: string, code: string): Promise<void> {
    const response = await fetch(`https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.replace('+', ''),
        type: 'template',
        template: {
          name: this.templateName,
          language: { code: this.language },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!response || !response.ok) {
      const body = response
        ? ((await response.json().catch(() => null)) as { error?: { code?: number } } | null)
        : null;
      throw new AppError(503, 'OTP_DELIVERY_FAILED', 'تعذّر إرسال الرمز عبر واتساب، حاول بعد قليل', {
        providerCode: body?.error?.code ?? null,
      });
    }
  }
}

class TwilioSmsDelivery implements OtpDelivery {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string
  ) {}

  async send(phone: string, code: string): Promise<void> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        From: this.fromNumber,
        Body: `رمز الدخول إلى رايد: ${code}`,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (!response || !response.ok) {
      throw new AppError(503, 'OTP_DELIVERY_FAILED', 'تعذّر إرسال الرمز برسالة نصية، حاول بعد قليل');
    }
  }
}

let delivery: OtpDelivery | null = null;

export function getOtpDelivery(): OtpDelivery {
  if (delivery) return delivery;

  switch (env.OTP_PROVIDER) {
    case 'whatsapp': {
      const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANGUAGE } = env;
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TEMPLATE_NAME) {
        throw new Error('WhatsApp OTP is not configured');
      }
      delivery = new WhatsAppDelivery(WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TEMPLATE_NAME, WHATSAPP_TEMPLATE_LANGUAGE);
      break;
    }
    case 'sms': {
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = env;
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
        throw new Error('SMS OTP is not configured');
      }
      delivery = new TwilioSmsDelivery(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER);
      break;
    }
    default:
      delivery = new DemoDelivery();
  }
  return delivery;
}
