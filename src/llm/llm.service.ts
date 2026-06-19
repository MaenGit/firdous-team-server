import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// 🔥 التعديل الأول: استخدام المكتبة الموحدة والحديثة
import { GoogleGenAI } from '@google/genai'; 
import axios from 'axios';

@Injectable()
export class LlmService {
  // 🔥 التعديل الثاني: تحديث نوع الكائن للـ SDK الجديد
  private ai: GoogleGenAI;

  constructor(private configService: ConfigService) {
    const geminiKey = this.configService.get<string>('GOOGLE_AI_STUDIO_KEY');
    if (geminiKey) {
      // 🔥 التعديل الثالث: الطريقة الجديدة لتعريف الكلاينت
      this.ai = new GoogleGenAI({ 
  apiKey: geminiKey,
});
    }
  }

  /**
   * توليد الإجابة الذكية مع ميزة التحويل التلقائي عند الفشل (Failover)
   */
  async generateResponse(question: string, contextDocs: string[]): Promise<string> {
    const contextText = contextDocs.length > 0 
      ? contextDocs.map((doc, i) => `[معلومة ${i + 1}]: ${doc}`).join('\n')
      : 'لا توجد معلومات مباشرة ومحدثة في قاعدة البيانات حالياً.';

    const systemPrompt = `
أنت المساعد الذكي الرسمي لـ "فريق ضاحيتنا الإعلامي" المسؤول عن خدمة أهالي ضاحية الفردوس.
مهمتك هي الإجابة على أسئلة الأهالي بناءً على "المعلومات المتاحة" فقط المرفقة أدناه.

المعلومات المتاحة والمحدثة من الإدارة:
${contextText}

السؤال المطروح من المواطن: "${question}"

شروط صارمة للرد:
1. أجب بلغة عربية واضحة، لبقة، ومباشرة تناسب أهالي الضاحية وبأسلوب ودي.
2. إذا كانت المعلومات المتاحة تحتوي على تفاصيل الإجابة (مثل مواعيد مياه أو سرافيس)، صغها بدقة مع ذكر التوقيت المذكور فيها.
3.  إذا كانت المعلومات المتاحة لا تحتوي على إجابة واضحة  أو كانت قديمة أو كانت فارغة، أجب بدقة وتأدب بالتالي تماماً بدون أي مقدمات: "I DONT KNOW".
ممنوع منعاً باتاً استخدام تنسيقات الـ Markdown مثل النجوم (*) أو الشرطات السفلية (_) في الإجابة. صغ النص كفقرات عادية ونقاط واضحة باستخدام النص الخام فقط.
"
`;

    // 2. المحاولة الأولى: استخدام Google Gemini 2.5 Flash الحديث عبر الـ SDK الجديد
    try {
      console.log('🤖 جاري محاولة توليد الإجابة عبر Google Gemini 2.5 Flash...');
      
      // 🔥 التعديل الرابع: استخدام الـ Syntax الجديد المستقر مباشرة دون getGenerativeModel
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: systemPrompt,
      });

      const responseText = response.text;

      
      if (responseText && responseText.trim().length > 0) {
        return responseText.trim();
      }
    } catch (geminiError) {
      console.error('⚠️ فشل الاتصال بـ Gemini 2.5، جاري التحويل تلقائياً إلى الخطة البديلة OpenRouter...', geminiError.message);
    }

    // 3. الخطة البديلة (Failover): استخدام OpenRouter مع Gemma 3 المتاح مجاناً (يبقى كما هو)
    try {
      const openRouterKey = this.configService.get<string>('OPENROUTER_API_KEY');
      if (!openRouterKey) {
        throw new Error('OpenRouter API key is missing from environment.');
      }

      console.log('🌐 جاري توليد الإجابة عبر الخطة البديلة OpenRouter باستخدام Gemma 3...');
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'google/gemma-3-27b-it:free', 
          messages: [{ role: 'user', content: systemPrompt }],
        },
        {
          headers: {
            Authorization: `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const openRouterText = response.data?.choices?.[0]?.message?.content;
      if (openRouterText) {
        return openRouterText.trim();
      }
    } catch (openRouterError) {
      console.error('❌ فشلت الخطة البديلة (Gemma 3) أيضاً:', openRouterError.message);
    }

    return 'نعتذر منك، الخدمة معطلة في الوقت الراهن شكرا لاستفسارك .';
  }
}