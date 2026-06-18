import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class RagService implements OnModuleInit {
  private ai: GoogleGenerativeAI;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_AI_STUDIO_KEY');
    
    if (!apiKey) {
      throw new Error('GOOGLE_AI_STUDIO_KEY is missing from .env file');
    }

    // 🔥 التعديل الجوهري: إجبار الحزمة على استخدام مسار المستقر v1 بدلاً من v1beta
    this.ai = new GoogleGenerativeAI(apiKey);
  }

  async onModuleInit() {
    await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
  }

  /**
   * تحويل النص إلى Vector
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // نمرر الـ apiVersion هنا داخل الـ requestOptions لتخطي الـ v1beta
      const model = this.ai.getGenerativeModel(
        { model: 'text-embedding-004' },
        { apiVersion: 'v1' } // تمرير الإعدادات هنا مدعوم ومضمون 100%
      );
      
      const result = await model.embedContent(text);
      return result.embedding.values;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * حفظ خبر جديد في قاعدة البيانات مع الـ Vector الخاص به
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
   * البحث الذكي المدمج بالتاريخ (Time-Aware Vector Search)
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

    if (results.length > 0) {
      return results.map(r => r.content);
    }

    return [];
  }
}