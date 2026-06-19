import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
// ✅ NEW IMPORT: Import the modern client class
import { GoogleGenAI } from '@google/genai'; 

@Injectable()
export class RagService implements OnModuleInit {
  // ✅ NEW TYPE: Updated to use the unified GoogleGenAI class
  private ai: GoogleGenAI; 

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_AI_STUDIO_KEY');
    
    if (!apiKey) {
      throw new Error('GOOGLE_AI_STUDIO_KEY is missing from .env file');
    }

    // 🔥 التعديل الجوهري: إجبار الـ SDK الموحد على استخدام مسار v1 المستقر
    this.ai = new GoogleGenAI({ 
      apiKey: apiKey,
      httpOptions: { apiVersion: 'v1' } 
    });
  }

  async onModuleInit() {
    await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
  }

  /**
   * Generates embedding using the unified @google/genai SDK
   */
  /**
   * Generates embedding using the unified @google/genai SDK
   */
  /**
   * Generates embedding using the unified @google/genai SDK
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: text,
        // This forces the model to return exactly 768 dimensions
        config: {
            outputDimensionality: 768
        }
    });

      // تحويل الرد إلى any لتفادي اعتراضات الـ TypeScript والوصول للمصفوفة مباشرة
      const res = response as any;

      // الحالة الأولى: الرد يحتوي على مصفوفة embeddings (وهو التصميم الأساسي للـ SDK الموحد)
      if (res.embeddings && res.embeddings.length > 0 && res.embeddings[0].values) {
        return res.embeddings[0].values;
      }

      // الحالة الثانية: الرد يحتوي على كائن embedding مفرد
      if (res.embedding && res.embedding.values) {
        return res.embedding.values;
      }
      
      throw new Error('No embedding values found in the response layout');
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Save knowledge with fixed position placeholder parameters
   */
  async saveKnowledge(content: string) {
    const embedding = await this.generateEmbedding(content);
    const embeddingString = `[${embedding.join(',')}]`;

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "Knowledge" (id, content, embedding, "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2::vector, NOW(), NOW());`,
      content,
      embeddingString,
    );
  }

  /**
   * Time-Aware Vector Search with corrected Prisma argument syntax
   */
  async searchKnowledge(question: string, similarityThreshold = 0.5): Promise<string[]> {
    const questionEmbedding = await this.generateEmbedding(question);
    const embeddingString = `[${questionEmbedding.join(',')}]`;

    const results: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT content, "createdAt",
       (1 - (embedding <=> $1::vector)) AS similarity
       FROM "Knowledge"
       WHERE (1 - (embedding <=> $1::vector)) > $2
       ORDER BY similarity DESC, "createdAt" DESC
       LIMIT 3;`,
      embeddingString,
      similarityThreshold,
    );

    if (results && results.length > 0) {
      return results.map(r => r.content);
    }

    return [];
  }

  async saveQuickResponse(keyword: string, reply: string): Promise<void> {
    // توليد الـ Embedding للكلمة المفتاحية (باستخدام نفس دالة التضمين المعتمدة لمشروعك)
    const embedding = await this.generateEmbedding(keyword); 
    const embeddingString = `[${embedding.join(',')}]`;

    // استخدام SQL خام لحفظ الـ Vector بشكل صحيح في Neon
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO "quick_responses" (id, keyword, reply, embedding, "createdAt")
      VALUES (gen_random_uuid(), $1, $2, $3::vector, NOW())
      ON CONFLICT (keyword) 
      DO UPDATE SET reply = $2, embedding = $3::vector;
    `, keyword, reply, embeddingString);
  }

  // 2️⃣ دالة البحث عن أقرب رد ثابت بحد قرب صارم جداً (Threshold) لضمان عدم الخلط
  async searchQuickResponse(question: string): Promise<{ reply: string } | null> {
    const questionEmbedding = await this.generateEmbedding(question);
    const embeddingString = `[${questionEmbedding.join(',')}]`;
    
    // 🎯 هنا نضع حد قرب صارم جداً (مثلاً أقل من 0.35) لأننا نريد التقاط التحيات والأسئلة المتطابقة في المعنى فقط
    const threshold = 0.35; 

    const matches: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT reply, (embedding <=> $1::vector) as distance 
      FROM "quick_responses"
      WHERE (embedding <=> $1::vector) < $2
      ORDER BY distance ASC 
      LIMIT 1;
    `, embeddingString, threshold);

    return matches.length > 0 ? { reply: matches[0].reply } : null;
  }
}
